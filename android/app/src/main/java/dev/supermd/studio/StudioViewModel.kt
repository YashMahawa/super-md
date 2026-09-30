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
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

data class Note(val id: String = UUID.randomUUID().toString(), val name: String = "Untitled.smd", val uri: String? = null, val content: String = "", val saved: String = "", val relative: String? = null) { val dirty get() = content != saved }
data class FileEntry(val name: String, val uri: String, val directory: Boolean, val relative: String)
data class StudioState(val tabs: List<Note> = listOf(Note(name = "Welcome.smd", content = sample, saved = sample)), val closedTabs: List<Note> = emptyList(), val activeId: String = "", val mode: String = "live", val fullscreen: Boolean = false, val normalZoom: Float = 100f, val fullscreenZoom: Float = 100f, val theme: String = "system", val fullscreenTheme: String = "black", val motion: Boolean = true, val font: String = "sans", val size: Float = 17f, val folder: String? = null, val files: List<FileEntry> = emptyList(), val busy: Boolean = false, val message: String? = null, val error: String? = null, val welcomed: Boolean = false, val pdf: String = "{\"pageSize\":\"a4\",\"margin\":18,\"fontSize\":10.5,\"lineHeight\":1.35,\"fontFamily\":\"Libertinus Serif\",\"pageNumbers\":true}") {
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

class StudioViewModel(app: Application) : AndroidViewModel(app) {
    private val prefs = app.getSharedPreferences("studio", 0)
    private val snapshot = File(app.filesDir, "workspace.json")
    private val mutable = MutableStateFlow(restore())
    val state = mutable.asStateFlow()
    private var persistJob: Job? = null
    private val pythonMutex = kotlinx.coroutines.sync.Mutex()
    var outputUri: Uri? = null
    private val resolver get() = getApplication<Application>().contentResolver
    private fun change(block: (StudioState) -> StudioState) { mutable.value = block(mutable.value); schedulePersist() }
    private fun restore(): StudioState {
        var s = StudioState(theme = prefs.getString("theme", "system")!!, fullscreenTheme = prefs.getString("fullTheme", "black")!!, motion = prefs.getBoolean("motion", true), welcomed = prefs.getBoolean("welcomed", false), font = prefs.getString("font", "sans")!!, size = prefs.getFloat("size", 17f), folder = prefs.getString("folder", null), pdf = prefs.getString("pdf", null) ?: StudioState().pdf)
        try {
            if (snapshot.isFile && snapshot.length() < 30_000_000) {
                val json = JSONObject(snapshot.readText()); val list = json.getJSONArray("tabs")
                val notes = (0 until list.length()).map { i -> val n = list.getJSONObject(i); Note(n.getString("id"), n.getString("name"), n.optString("uri").takeIf { it.isNotBlank() }, n.getString("content"), n.getString("saved"), n.optString("relative").takeIf { it.isNotBlank() }) }
                val closed = json.optJSONArray("closed") ?: JSONArray()
                val closedNotes = (0 until closed.length()).map { i -> val n = closed.getJSONObject(i); Note(n.getString("id"), n.getString("name"), n.optString("uri").takeIf { it.isNotBlank() }, n.getString("content"), n.getString("saved"), n.optString("relative").takeIf { it.isNotBlank() }) }
                if (notes.isNotEmpty()) s = s.copy(tabs = notes, closedTabs = closedNotes.take(12), activeId = json.optString("active"), mode = json.optString("mode", "live"), normalZoom = json.optDouble("normalZoom", 100.0).toFloat(), fullscreenZoom = json.optDouble("fullscreenZoom", 100.0).toFloat())
            }
        } catch (_: Exception) { s = s.copy(error = "The recovery snapshot could not be read. Your original files are untouched.") }
        return s
    }
    private fun schedulePersist() { persistJob?.cancel(); val current = mutable.value; persistJob = viewModelScope.launch(Dispatchers.IO) { delay(200); persist(current) } }
    @Synchronized private fun persist(s: StudioState) {
        try {
            val tabs = JSONArray(); s.tabs.forEach { tabs.put(JSONObject().put("id", it.id).put("name", it.name).put("uri", it.uri ?: "").put("content", it.content).put("saved", it.saved).put("relative", it.relative ?: "")) }
            val closed = JSONArray(); s.closedTabs.forEach { closed.put(JSONObject().put("id", it.id).put("name", it.name).put("uri", it.uri ?: "").put("content", it.content).put("saved", it.saved).put("relative", it.relative ?: "")) }
            val temporary = File(snapshot.parentFile, "workspace.tmp"); temporary.outputStream().use { stream -> stream.write(JSONObject().put("active", s.active.id).put("tabs", tabs).put("closed", closed).put("mode", s.mode).put("normalZoom", s.normalZoom).put("fullscreenZoom", s.fullscreenZoom).toString().toByteArray()); stream.fd.sync() }
            if (!temporary.renameTo(snapshot)) error("Could not replace recovery snapshot")
            prefs.edit().putString("theme", s.theme).putString("fullTheme", s.fullscreenTheme).putBoolean("motion", s.motion).putString("font", s.font).putFloat("size", s.size).putString("folder", s.folder).putString("pdf", s.pdf).putBoolean("welcomed", s.welcomed).apply()
        } catch (error: Exception) { viewModelScope.launch { mutable.value = mutable.value.copy(error = "Draft recovery could not save: ${error.message}. Please save your note to a file.") } }
    }
    fun flush() { persistJob?.cancel(); val current = mutable.value; viewModelScope.launch(Dispatchers.IO) { persist(current) } }
    fun edit(id: String, content: String) = change { s -> s.copy(tabs = s.tabs.map { if (it.id == id) it.copy(content = content) else it }) }
    fun newNote() { val note = Note(); change { it.copy(tabs = it.tabs + note, activeId = note.id) } }
    fun select(id: String) = change { it.copy(activeId = id) }
    fun close(id: String) {
        val note = mutable.value.tabs.find { it.id == id } ?: return
        change { val remaining = it.tabs.filter { n -> n.id != id }; val next = remaining.ifEmpty { listOf(Note()) }; it.copy(tabs = next, closedTabs = (listOf(note) + it.closedTabs).take(12), activeId = if (it.active.id == id) next.first().id else it.activeId, message = "Tab closed. Reopen from the menu to recover edits.") }
    }
    fun reopen() { val note = mutable.value.closedTabs.firstOrNull() ?: return; change { it.copy(tabs = it.tabs + note, closedTabs = it.closedTabs.drop(1), activeId = note.id) } }
    fun mode(value: String) = change { it.copy(mode = value) }
    fun fullscreen(value: Boolean) = change { it.copy(fullscreen = value) }
    fun zoom(value: Float) = change { s -> if (s.fullscreen) s.copy(fullscreenZoom = value.coerceIn(60f, 240f)) else s.copy(normalZoom = value.coerceIn(60f, 240f)) }
    fun appearance(theme: String? = null, fullTheme: String? = null, motion: Boolean? = null, font: String? = null, size: Float? = null) = change { it.copy(theme = theme ?: it.theme, fullscreenTheme = fullTheme ?: it.fullscreenTheme, motion = motion ?: it.motion, font = font ?: it.font, size = size ?: it.size) }
    fun pdf(value: String) = change { it.copy(pdf = value) }
    fun welcomeDone() = change { it.copy(welcomed = true) }
    fun dismissMessage() { mutable.value = mutable.value.copy(message = null) }
    fun dismissError() { mutable.value = mutable.value.copy(error = null) }
    fun fail(message: String) { mutable.value = mutable.value.copy(busy = false, error = message) }
    fun busy(value: Boolean) { mutable.value = mutable.value.copy(busy = value) }
    fun open(uri: Uri, relative: String? = null) = viewModelScope.launch {
        try {
            val note = withContext(Dispatchers.IO) {
                val existing = mutable.value.tabs.find { it.uri == uri.toString() }; if (existing != null) return@withContext existing
                try { resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION) } catch (_: SecurityException) { }
                val name = DocumentFile.fromSingleUri(getApplication(), uri)?.name ?: "Note.md"
                val content = resolver.openInputStream(uri)?.use { stream -> readLimited(stream, 20_000_000).toString(Charsets.UTF_8) } ?: error("Document permission is unavailable; choose it again")
                Note(name = name, uri = uri.toString(), content = content, saved = content, relative = relative)
            }
            change { s -> val existing = s.tabs.find { it.uri == note.uri }; s.copy(tabs = if (existing != null) s.tabs else s.tabs + note, activeId = existing?.id ?: note.id) }
        } catch (error: Exception) { fail("Could not open note: ${error.message}") }
    }
    fun save(uri: Uri? = null) = viewModelScope.launch {
        val note = mutable.value.active; val target = uri ?: note.uri?.let(Uri::parse) ?: return@launch
        busy(true)
        try {
            withContext(Dispatchers.IO) { resolver.openOutputStream(target, "wt")?.use { it.write(note.content.toByteArray()) } ?: error("Writing permission is unavailable; use Save as") }
            change { s -> s.copy(busy = false, tabs = s.tabs.map { if (it.id == note.id) it.copy(uri = target.toString(), name = DocumentFile.fromSingleUri(getApplication(), target)?.name ?: note.name, saved = note.content) else it }, message = "Saved") }
        } catch (error: Exception) { fail("Could not save note: ${error.message}") }
    }
    fun setFolder(uri: Uri) = viewModelScope.launch {
        try {
            withContext(Dispatchers.IO) { resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION) }
            change { it.copy(folder = uri.toString()) }; listFolder(uri, "")
        } catch (error: Exception) { fail("Could not open folder: ${error.message}") }
    }
    fun listFolder(uri: Uri, relative: String) = viewModelScope.launch {
        try {
            val entries = withContext(Dispatchers.IO) {
                var folder = DocumentFile.fromTreeUri(getApplication(), Uri.parse(mutable.value.folder ?: uri.toString())) ?: error("Choose the folder again to restore access")
                relative.split('/').filter { it.isNotEmpty() }.forEach { part -> folder = folder.findFile(part) ?: error("Folder disappeared") }
                folder.listFiles().mapNotNull { f -> val name = f.name ?: return@mapNotNull null; if (name.startsWith('.')) return@mapNotNull null; if (f.isDirectory || name.substringAfterLast('.').lowercase() in listOf("md", "smd", "markdown")) FileEntry(name, f.uri.toString(), f.isDirectory, (if (relative.isEmpty()) "" else "$relative/") + name) else null }.sortedWith(compareByDescending<FileEntry> { it.directory }.thenBy { it.name.lowercase() })
            }
            mutable.value = mutable.value.copy(files = entries)
        } catch (error: Exception) { fail("Could not list folder: ${error.message}") }
    }
    suspend fun asset(document: String, source: String): String = withContext(Dispatchers.IO) {
        val note = mutable.value.tabs.find { it.uri == document } ?: error("The image's document is no longer open")
        val folderUri = mutable.value.folder?.let(Uri::parse) ?: error("Open the note's containing folder to grant access to relative images")
        var file = DocumentFile.fromTreeUri(getApplication(), folderUri) ?: error("Restore folder access by opening it again")
        val rootId = DocumentsContract.getTreeDocumentId(folderUri)
        val documentId = runCatching { DocumentsContract.getDocumentId(Uri.parse(document)) }.getOrDefault("")
        val relative = note.relative ?: documentId.takeIf { it.startsWith("$rootId/") }?.removePrefix("$rootId/") ?: documentId.takeIf { it.startsWith(rootId) }?.removePrefix(rootId)?.trimStart('/')
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
        pythonMutex.lock()
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
            // Terminate only this app's worker, including when code loops forever.
            runCatching { remote?.send(android.os.Message.obtain(null, 2)) }
            connection?.let { runCatching { app.unbindService(it) } }
            input.delete(); output.delete()
            pythonMutex.unlock()
        }
    }
    suspend fun export(content: String, options: String, assets: JSONObject) = withContext(Dispatchers.IO) {
        val target = outputUri ?: error("Choose a PDF destination first")
        val staging = File(getApplication<Application>().cacheDir, "pdf-${UUID.randomUUID()}").apply { mkdirs() }
        try {
            val assetDir = File(staging, "assets").apply { mkdirs() }
            assets.keys().forEach { key -> require(Regex("[a-zA-Z0-9_.-]+").matches(key)); File(assetDir, key).writeBytes(Base64.decode(assets.getString(key), Base64.DEFAULT)) }
            val output = File(staging, "document.pdf")
            val error = PdfEngine.export(content, options, assetDir.absolutePath, output.absolutePath)
            if (error.isNotEmpty()) error(error)
            resolver.openOutputStream(target, "wt")?.use { stream -> output.inputStream().use { it.copyTo(stream) } } ?: error("Cannot write PDF destination")
            withContext(Dispatchers.Main) { mutable.value = mutable.value.copy(busy = false, message = "PDF exported"); outputUri = null }
        } finally { staging.deleteRecursively() }
    }
}
private fun readLimited(input: java.io.InputStream, limit: Int): ByteArray {
    val output = java.io.ByteArrayOutputStream(); val buffer = ByteArray(8192)
    while (true) { val count = input.read(buffer); if (count < 0) break; if (output.size() + count > limit) error("File exceeds the ${limit / 1_000_000} MB limit"); output.write(buffer, 0, count) }
    return output.toByteArray()
}
object PdfEngine {
    init { System.loadLibrary("smd_core") }
    @JvmStatic external fun export(markdown: String, options: String, assets: String, output: String): String
}
