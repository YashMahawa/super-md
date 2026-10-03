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

// SAF documents can be shared by independent Android activities. Serialize
// comparison, staging, write and saved-state updates across those windows.
private val documentWrites = Mutex()

data class Note(val id: String = UUID.randomUUID().toString(), val name: String = "Untitled.md", val uri: String? = null, val content: String = "", val saved: String = "", val relative: String? = null, val assetDirectory: String? = null) { val dirty get() = content != saved; val portable get() = assetDirectory != null }
data class RecentNote(val name: String, val uri: String, val relative: String? = null)
data class FileEntry(val name: String, val uri: String, val directory: Boolean, val relative: String)
data class OutlineHeading(val id: String, val title: String, val level: Int, val offset: Int)
data class StudioState(val accent: String = "system", val widthPercent: Float = 80f, val lineHeight: Float = 1.65f, val autosave: Boolean = true, val customFonts: List<String> = emptyList(), val readerOverlay: Boolean = false, val tabs: List<Note> = listOf(Note(name = "Welcome.md", content = sample, saved = sample)), val closedTabs: List<Note> = emptyList(), val activeId: String = "", val mode: String = "live", val fullscreen: Boolean = false, val normalZoom: Float = 100f, val fullscreenZoom: Float = 100f, val theme: String = "system", val fullscreenTheme: String = "black", val motion: Boolean = true, val font: String = "Manrope", val size: Float = 17f, val folder: String? = null, val files: List<FileEntry> = emptyList(), val busy: Boolean = false, val message: String? = null, val error: String? = null, val welcomed: Boolean = false, val pdf: String = "{\"pageSize\":\"a4\",\"margin\":18,\"fontSize\":10.5,\"lineHeight\":1.35,\"fontFamily\":\"Manrope\",\"pageNumbers\":true}") {
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
    private val recentMutable = MutableStateFlow(runCatching { val list = JSONArray(prefs.getString("recent", "[]")); (0 until minOf(list.length(), 24)).map { i -> val n = list.getJSONObject(i); RecentNote(n.getString("name"), n.getString("uri"), n.optString("relative").takeIf { it.isNotBlank() }) } }.getOrDefault(emptyList()))
    val recent = recentMutable.asStateFlow()
    var requestPortable: (() -> Unit)? = null
    private fun remember(note: Note) {
        val uri = note.uri ?: return
        recentMutable.value = (listOf(RecentNote(note.name, uri, note.relative)) + recentMutable.value.filter { it.uri != uri }).take(24)
        prefs.edit().putString("recent", JSONArray().apply { recentMutable.value.forEach { put(JSONObject().put("name", it.name).put("uri", it.uri).put("relative", it.relative ?: "")) } }.toString()).apply()
    }
    fun clearRecent() { recentMutable.value = emptyList(); prefs.edit().remove("recent").apply() }
    private val snapshot = if (workspaceKey == "main") File(app.filesDir, "workspace.json") else File(app.filesDir, "workspaces/$workspaceKey.json").also { it.parentFile!!.mkdirs() }
    private val mutable = MutableStateFlow(restore())
    private val preferencesChanged = android.content.SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
        if (key == "recent") recentMutable.value = runCatching { val list = JSONArray(prefs.getString("recent", "[]")); (0 until minOf(list.length(), 24)).map { i -> val n = list.getJSONObject(i); RecentNote(n.getString("name"), n.getString("uri"), n.optString("relative").takeIf { it.isNotBlank() }) } }.getOrDefault(emptyList())
        if (key in setOf("accent", "theme", "fullTheme", "motion", "font", "size", "pdf", "welcomed", "widthPercent", "lineHeight", "autosave", "fonts")) {
            mutable.value = mutable.value.copy(theme = prefs.getString("theme", "system")!!, fullscreenTheme = prefs.getString("fullTheme", "black")!!, motion = prefs.getBoolean("motion", true), font = prefs.getString("font", "Manrope")!!, size = prefs.getFloat("size", 17f), pdf = prefs.getString("pdf", null) ?: StudioState().pdf, welcomed = prefs.getBoolean("welcomed", false))
                .copy(accent = prefs.getString("accent","system")!!, widthPercent = prefs.getFloat("widthPercent",80f),lineHeight = prefs.getFloat("lineHeight",1.65f),autosave = prefs.getBoolean("autosave",true),customFonts = fonts.families)
        }
    }
    private var observedUri:String?=null
    private val documentObserver=object:android.database.ContentObserver(android.os.Handler(android.os.Looper.getMainLooper())) {
        override fun onChange(selfChange:Boolean){refreshExternal()}
    }
    private fun observeActive() {
        val uri=mutable.value.active.uri
        if(uri==observedUri)return
        resolver.unregisterContentObserver(documentObserver);observedUri=uri
        uri?.let{runCatching{resolver.registerContentObserver(Uri.parse(it),true,documentObserver)}}
    }
    init { prefs.registerOnSharedPreferenceChangeListener(preferencesChanged);observeActive() }
    override fun onCleared() { prefs.unregisterOnSharedPreferenceChangeListener(preferencesChanged);resolver.unregisterContentObserver(documentObserver); super.onCleared() }
    val state = mutable.asStateFlow()
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
    private var persistJob: Job? = null
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
                val note=mutable.value.tabs.find { it.id==next && it.uri!=null && it.dirty } ?: continue
                if (!mutable.value.autosave) continue
                try {
                    // Do not cancel an in-flight write when another keystroke or
                    // window transition arrives. Recovery remains an independent stream.
                    withContext(kotlinx.coroutines.NonCancellable) {
                        documentWrites.withLock {
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
    var shareReady: ((Intent) -> Unit)? = null
    private var shareFile: File? = null
    fun prepareShare(format: String): Boolean {
        if (mutable.value.busy || format !in listOf("pdf", "smd", "md")) return false
        val folder = File(getApplication<Application>().cacheDir, "share/${UUID.randomUUID()}").apply { mkdirs() }
        val stem = mutable.value.active.name.substringBeforeLast('.').replace(Regex("[^\\p{L}\\p{N} _.-]"), "_").take(100).ifBlank { "Note" }
        val file = File(folder, "$stem.$format")
        shareFile = file
        busy(true)
        when (format) {
            "pdf" -> outputUri = Uri.fromFile(file)
            "smd" -> portableOutput = Uri.fromFile(file)
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
        val mime = when (file.extension) { "pdf" -> "application/pdf"; "smd" -> "application/vnd.supermd.smd"; else -> "text/markdown" }
        val send = Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION).apply { clipData = android.content.ClipData.newUri(app.contentResolver, file.name, uri) }
        shareFile = null
        mutable.value = mutable.value.copy(busy = false, message = "Share copy ready")
        shareReady?.invoke(send) ?: error("The share screen is no longer open. Your copy is still in the app cache.")
        return true
    }
    private val resolver get() = getApplication<Application>().contentResolver
    private fun change(block: (StudioState) -> StudioState) { mutable.value = block(mutable.value);observeActive(); schedulePersist() }
    private fun restore(): StudioState {
        var s = StudioState(theme = prefs.getString("theme", "system")!!, fullscreenTheme = prefs.getString("fullTheme", "black")!!, motion = prefs.getBoolean("motion", true), welcomed = prefs.getBoolean("welcomed", false), font = prefs.getString("font", "Manrope")!!, size = prefs.getFloat("size", 17f), folder = windowPrefs.getString("folder", if (workspaceKey == "main" && !windowPrefs.getBoolean("folderMigrated", false)) prefs.getString("folder", null) else null), pdf = prefs.getString("pdf", null) ?: StudioState().pdf)
        s = s.copy(accent = prefs.getString("accent","system")!!, widthPercent = prefs.getFloat("widthPercent",80f),lineHeight = prefs.getFloat("lineHeight",1.65f),autosave = prefs.getBoolean("autosave",true),customFonts = fonts.families)
        try {
            if (snapshot.isFile && snapshot.length() < 30_000_000) {
                val json = JSONObject(snapshot.readText()); val list = json.getJSONArray("tabs")
                val notes = (0 until list.length()).map { i -> val n = list.getJSONObject(i); Note(n.getString("id"), n.getString("name"), n.optString("uri").takeIf { it.isNotBlank() }, n.getString("content"), n.getString("saved"), n.optString("relative").takeIf { it.isNotBlank() }, n.optString("assetDirectory").takeIf { it.isNotBlank() }) }
                val closed = json.optJSONArray("closed") ?: JSONArray()
                val closedNotes = (0 until closed.length()).map { i -> val n = closed.getJSONObject(i); Note(n.getString("id"), n.getString("name"), n.optString("uri").takeIf { it.isNotBlank() }, n.getString("content"), n.getString("saved"), n.optString("relative").takeIf { it.isNotBlank() }, n.optString("assetDirectory").takeIf { it.isNotBlank() }) }
                if (notes.isNotEmpty()) s = s.copy(tabs = notes, closedTabs = closedNotes.take(12), activeId = json.optString("active"), mode = json.optString("mode", "live"), normalZoom = json.optDouble("normalZoom", 100.0).toFloat(), fullscreenZoom = json.optDouble("fullscreenZoom", 100.0).toFloat())
            }
        } catch (_: Exception) { s = s.copy(error = "The recovery snapshot could not be read. Your original files are untouched.") }
        return s
    }
    private fun schedulePersist() { persistJob?.cancel(); val current = mutable.value; persistJob = viewModelScope.launch(Dispatchers.IO) { delay(200); persist(current) } }
    @Synchronized private fun persist(s: StudioState) {
        try {
            val tabs = JSONArray(); s.tabs.forEach { tabs.put(JSONObject().put("id", it.id).put("name", it.name).put("uri", it.uri ?: "").put("content", it.content).put("saved", it.saved).put("relative", it.relative ?: "").put("assetDirectory", it.assetDirectory ?: "")) }
            val closed = JSONArray(); s.closedTabs.forEach { closed.put(JSONObject().put("id", it.id).put("name", it.name).put("uri", it.uri ?: "").put("content", it.content).put("saved", it.saved).put("relative", it.relative ?: "").put("assetDirectory", it.assetDirectory ?: "")) }
            val temporary = File(snapshot.parentFile, snapshot.name + ".tmp"); temporary.outputStream().use { stream -> stream.write(JSONObject().put("active", s.active.id).put("tabs", tabs).put("closed", closed).put("mode", s.mode).put("normalZoom", s.normalZoom).put("fullscreenZoom", s.fullscreenZoom).toString().toByteArray()); stream.fd.sync() }
            if (!temporary.renameTo(snapshot)) error("Could not replace recovery snapshot")
            windowPrefs.edit().putBoolean("folderMigrated", true).putString("folder", s.folder).apply()
        } catch (error: Exception) { viewModelScope.launch { mutable.value = mutable.value.copy(error = "Draft recovery could not save: ${error.message}. Please save your note to a file.") } }
    }
    fun flush() { persistJob?.cancel(); val current = mutable.value; viewModelScope.launch(Dispatchers.IO) { persist(current) } }
    fun edit(id: String, content: String) { change { s -> s.copy(tabs = s.tabs.map { if (it.id == id) it.copy(content = content) else it }) }; scheduleAutosave(id) }
    fun newNote() { val note = Note(); change { it.copy(tabs = it.tabs + note, activeId = note.id) } }
    fun select(id: String) = change { it.copy(activeId = id) }
    fun cycle(direction:Int) {val s=mutable.value;val index=s.tabs.indexOfFirst{it.id==s.active.id};select(s.tabs[Math.floorMod(index+direction,s.tabs.size)].id)}
    fun tabNumber(number:Int) {val s=mutable.value;val index=if(number==9)s.tabs.lastIndex else number-1;s.tabs.getOrNull(index)?.let{select(it.id)}}
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
    fun close(id: String) {
        val note = mutable.value.tabs.find { it.id == id } ?: return
        change { val remaining = it.tabs.filter { n -> n.id != id }; val next = remaining.ifEmpty { listOf(Note()) }; val empty = note.uri == null && note.content.isBlank(); it.copy(tabs = next, closedTabs = (if (empty) it.closedTabs else listOf(note) + it.closedTabs).take(12), activeId = if (it.active.id == id) next.first().id else it.activeId, message = if (empty) "Empty tab discarded" else "Tab closed. Reopen from the menu to recover edits.") }
    }
    fun reopen() { val note = mutable.value.closedTabs.firstOrNull() ?: return; change { it.copy(tabs = it.tabs + note, closedTabs = it.closedTabs.drop(1), activeId = note.id) } }
    fun mode(value: String) = change { it.copy(mode = value) }
    fun fullscreen(value: Boolean) = change { it.copy(fullscreen = value) }
    fun zoom(value: Float) = change { s -> if (s.fullscreen) s.copy(fullscreenZoom = value.coerceIn(60f, 240f)) else s.copy(normalZoom = value.coerceIn(60f, 240f)) }
    fun appearance(accent: String? = null, theme: String? = null, fullTheme: String? = null, motion: Boolean? = null, font: String? = null, size: Float? = null) {
        change { it.copy(accent = accent ?: it.accent, theme = theme ?: it.theme, fullscreenTheme = fullTheme ?: it.fullscreenTheme, motion = motion ?: it.motion, font = font ?: it.font, size = size ?: it.size) }
        prefs.edit().apply { accent?.let { putString("accent", it) }; theme?.let { putString("theme", it) }; fullTheme?.let { putString("fullTheme", it) }; motion?.let { putBoolean("motion", it) }; font?.let { putString("font", it) }; size?.let { putFloat("size", it) } }.apply()
    }
    fun pdf(value: String) { change { it.copy(pdf = value) }; prefs.edit().putString("pdf", value).apply() }
    fun noteLocation(): String = prefs.getString("newNoteLocation", "") ?: ""
    fun noteLocation(uri: Uri) {
        getApplication<Application>().contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        prefs.edit().putString("newNoteLocation", uri.toString()).apply()
    }
    fun reading(widthPercent: Float? = null, lineHeight: Float? = null, autosave: Boolean? = null) {
        val width=widthPercent?.takeIf { it.isFinite() }?.coerceIn(50f,100f)
        val leading=lineHeight?.takeIf { it.isFinite() }?.coerceIn(1.15f,2.2f)
        change { it.copy(widthPercent=width ?: it.widthPercent,lineHeight=leading ?: it.lineHeight,autosave=autosave ?: it.autosave) }
        prefs.edit().apply { width?.let { putFloat("widthPercent",it) };leading?.let { putFloat("lineHeight",it) };autosave?.let { putBoolean("autosave",it) } }.apply()
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
    fun busy(value: Boolean) { mutable.value = mutable.value.copy(busy = value) }
    fun open(uri: Uri, relative: String? = null) = viewModelScope.launch {
        try {
            val note = withContext(Dispatchers.IO) {
                val existing = mutable.value.tabs.find { it.uri == uri.toString() }; if (existing != null) return@withContext existing
                try { resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION) } catch (_: SecurityException) { }
                val name = DocumentFile.fromSingleUri(getApplication(), uri)?.name ?: "Note.md"
                resolver.openInputStream(uri)?.use { stream ->
                    val buffered = stream.buffered()
                    buffered.mark(4096)
                    val prefix = ByteArray(2048); val count = buffered.read(prefix); buffered.reset()
                    val header = if (count > 0) String(prefix, 0, count, Charsets.UTF_8).trimStart('\uFEFF', ' ', '\n', '\r', '\t') else ""
                    val portable = name.endsWith(".fmd", true) || name.endsWith(".smd", true) && header.startsWith('{') && Regex("\"format\"\\s*:\\s*\"supermd-(smd|fmd)\"").containsMatchIn(header)
                    if (portable) { val opened = media.openFmd(buffered); Note(name = name, uri = uri.toString(), content = opened.markdown, saved = opened.markdown, relative = relative, assetDirectory = opened.directory) }
                    else { val content = readLimited(buffered, 20_000_000).toString(Charsets.UTF_8); Note(name = name, uri = uri.toString(), content = content, saved = content, relative = relative) }
                } ?: error("Document permission is unavailable; choose it again")
            }
            change { s -> val existing = s.tabs.find { it.uri == note.uri }; s.copy(tabs = if (existing != null) s.tabs else s.tabs + note, activeId = existing?.id ?: note.id) }
            remember(note)
        } catch (error: Exception) { fail("Could not open note: ${error.message}") }
    }
    fun save(uri: Uri? = null) = viewModelScope.launch {
        val note = mutable.value.active; val target = uri ?: note.uri?.let(Uri::parse) ?: return@launch
        busy(true)
        try {
            documentWrites.withLock {
            val savedName = withContext(Dispatchers.IO) {
                require(!note.portable || uri != null) { "Use portable save for this SMD file" }
                copyAttachments(note, target)
                resolver.openOutputStream(target, "wt")?.use { it.write(note.content.toByteArray()) } ?: error("Writing permission is unavailable; use Save as")
                DocumentFile.fromSingleUri(getApplication(), target)?.name ?: note.name
            }
            change { s -> s.copy(busy = false, tabs = s.tabs.map { if (it.id == note.id) it.copy(uri = target.toString(), name = savedName, saved = note.content, assetDirectory = null) else it }, message = "Saved") }
            mutable.value.tabs.find { it.id == note.id }?.let(::remember)
            }
        } catch (error: Exception) { fail("Could not save note: ${error.message}") }
    }
    fun setFolder(uri: Uri) = viewModelScope.launch {
        try {
            withContext(Dispatchers.IO) { resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION) }
            change { it.copy(folder = uri.toString()) }; listFolder(uri, "")
        } catch (error: Exception) { fail("Could not open folder: ${error.message}") }
    }
    fun closeFolder() = change { it.copy(folder = null, files = emptyList()) }
    fun listFolder(uri: Uri, relative: String) = viewModelScope.launch {
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
        val staged = File(getApplication<Application>().cacheDir, "fmd-${UUID.randomUUID()}.tmp")
        try {
            staged.outputStream().use { media.writeFmd(it, content, assets) }
            // Extract assets independently so a saved draft can immediately resolve
            // new portable references without carrying binary data in its state.
            val opened = if (save) staged.inputStream().use(media::openFmd) else null
            resolver.openOutputStream(target, "wt")?.use { output -> staged.inputStream().use { it.copyTo(output) } } ?: error("Cannot write portable file")
            withContext(Dispatchers.Main) {
                if (save) { change { s -> s.copy(tabs = s.tabs.map { if (it.id == id) it.copy(content = if (it.content == originalContent) content else it.content, saved = content, assetDirectory = opened!!.directory) else it }, busy = false, message = "Portable note saved") }; mutable.value.tabs.find { it.id == id }?.let(::remember) }
                else { portableOutput = null; if (!finishShare(target)) mutable.value = mutable.value.copy(busy = false, message = "Portable .smd exported") }
            }
        } finally { staged.delete() }
        }
    }
    fun importDropped(uris: List<Uri>, id: String, result: (JSONArray?) -> Unit) = viewModelScope.launch {
        try { val images = withContext(Dispatchers.IO) { media.importUris(uris) }; if (mutable.value.active.id == id) result(images) else { val insertion = (0 until images.length()).joinToString("\n\n") { i -> val image = images.getJSONObject(i); "![${image.getString("alt").replace("[", "\\[").replace("]", "\\]")}](<${image.getString("source")}>)" }; val note = mutable.value.tabs.find { it.id == id }; if (note != null) edit(id, note.content + "\n\n" + insertion + "\n"); result(null) } }
        catch (error: Exception) { fail("Could not insert image: ${error.message}"); result(null) }
    }
    suspend fun export(content: String, options: String, assets: JSONObject) = withContext(Dispatchers.IO) {
        val target = outputUri ?: error("Choose a PDF destination first")
        val staging = File(getApplication<Application>().cacheDir, "pdf-${UUID.randomUUID()}").apply { mkdirs() }
        try {
            val assetDir = File(staging, "assets").apply { mkdirs() }
            assets.keys().forEach { key -> require(Regex("[a-zA-Z0-9_.-]+").matches(key)); File(assetDir, key).writeBytes(Base64.decode(assets.getString(key), Base64.DEFAULT)) }
            fonts.addPdfFonts(JSONObject(options).optString("fontFamily"),assetDir)
            val output = File(staging, "document.pdf")
            val error = PdfEngine.export(content, options, assetDir.absolutePath, output.absolutePath)
            if (error.isNotEmpty()) error(error)
            resolver.openOutputStream(target, "wt")?.use { stream -> output.inputStream().use { it.copyTo(stream) } } ?: error("Cannot write PDF destination")
            withContext(Dispatchers.Main) { if (!finishShare(target)) mutable.value = mutable.value.copy(busy = false, message = "PDF exported"); outputUri = null }
        } finally { staging.deleteRecursively() }
    }
}
object PdfEngine {
    init { System.loadLibrary("smd_core") }
    @JvmStatic external fun export(markdown: String, options: String, assets: String, output: String): String
    @JvmStatic external fun imageSources(markdown: String): String
    @JvmStatic external fun fontFamilies(path: String): String
}
