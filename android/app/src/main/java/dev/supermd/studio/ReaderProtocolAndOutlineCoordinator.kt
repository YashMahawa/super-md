package dev.supermd.studio

import android.app.Application
import android.util.JsonWriter
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStreamWriter
import java.nio.file.Files
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

internal class ReaderProtocolAndOutlineCoordinator(
    private val app: Application,
    private val scope: CoroutineScope,
    private val readerEcho: MutableMap<String, String>,
    private val readerEditProtocol: ReaderEditProtocol,
    private val readState: () -> StudioState,
    private val changeState: ((StudioState) -> StudioState) -> Unit,
    private val editNote: (String, String) -> Unit,
    private val fail: (String) -> Unit,
) {
    private val outlineMutable = MutableStateFlow<List<OutlineHeading>>(emptyList())
    val headings: StateFlow<List<OutlineHeading>> = outlineMutable.asStateFlow()
    private val imageMutable = MutableStateFlow(false)
    val imageOverlay: StateFlow<Boolean> = imageMutable.asStateFlow()
    @Volatile var lastOutlineNoteId: String = ""
        private set

    fun setImageOverlay(visible: Boolean) {
        imageMutable.value = visible
    }

    fun outline(id: String, entries: JSONArray) {
        if (id != readState().active.id) return
        val parsed = (0 until minOf(entries.length(), 2000)).map { index ->
            val entry = entries.getJSONObject(index)
            OutlineHeading(
                entry.getString("id"),
                entry.getString("title"),
                entry.getInt("level").coerceIn(1, 6),
                entry.getInt("offset").coerceAtLeast(0),
            )
        }
        if (id != readState().active.id) return
        outlineMutable.value = parsed
        lastOutlineNoteId = id
        val note = readState().tabs.firstOrNull { it.id == id } ?: return
        if (note.uri == null && note.name.startsWith("Untitled") && parsed.isNotEmpty()) {
            val title = parsed.first().title.filter { it.code >= 32 && it !in "/\\:*?\"<>|" }.trim().trim('.').take(120)
            if (title.isNotEmpty()) {
                changeState { s ->
                    s.copy(
                        tabs = s.tabs.map {
                            if (it.id == id && it.uri == null && it.name.startsWith("Untitled")) {
                                it.copy(name = title + if (it.portable) ".smd" else ".md")
                            } else it
                        },
                    )
                }
            }
        }
    }

    fun clearReaderEditProtocol(id: String) {
        readerEditProtocol.clear(id)
    }

    fun readerStateIsNativeAuthoritative(id: String): Boolean =
        readState().tabs.find { it.id == id }?.let { readerEditProtocol.matchesNative(id, it.content) } == true

    /** An edit that came from the reader itself; only these may skip the echo. */
    fun readerEdit(id: String, content: String, protocolPatch: Boolean = false) {
        if (readState().tabs.none { it.id == id }) return
        if (!protocolPatch) readerEditProtocol.clear(id)
        readerEcho[id] = content
        editNote(id, content)
    }

    fun readerSync(id: String, epoch: String, revision: Long, content: String): JSONObject {
        val note = readState().tabs.find { it.id == id }
        return readerProtocolJson(readerEditProtocol.sync(id, epoch, revision, content, note?.content))
    }

    fun readerPatch(
        id: String,
        epoch: String,
        baseRevision: Long,
        revision: Long,
        changes: List<ReaderEditChange>,
    ): JSONObject {
        val note = readState().tabs.find { it.id == id }
        val ack = readerEditProtocol.patch(id, epoch, baseRevision, revision, changes, note?.content) { updated ->
            readerEdit(id, updated, protocolPatch = true)
        }
        return readerProtocolJson(ack)
    }

    fun readerResync(
        id: String,
        epoch: String,
        revision: Long,
        bases: List<String>,
        content: String,
    ): JSONObject {
        val note = readState().tabs.find { it.id == id }
        val ack = readerEditProtocol.resync(id, epoch, revision, bases, content, note?.content) { updated ->
            readerEdit(id, updated, protocolPatch = true)
        }
        if (!ack.accepted) preserveReaderConflictDraft(id, note?.name ?: "Reader draft", content)
        return readerProtocolJson(ack)
    }

    /** Preserve a bounded draft from a malformed resync envelope when its text is still usable. */
    fun preserveMalformedReaderResync(id: String?, content: String?) {
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
        scope.launch(Dispatchers.IO) {
            var temporary: File? = null
            val saved = runCatching {
                val root = Files.createDirectories(File(app.filesDir, "reader-conflicts").toPath()).toFile()
                val destination = File(root, "reader-conflict-${UUID.randomUUID()}.json")
                val tempFile = File(root, destination.name + ".tmp")
                temporary = tempFile
                val output = FileOutputStream(tempFile)
                val writer = JsonWriter(OutputStreamWriter(output, Charsets.UTF_8))
                try {
                    writer.beginObject().name("id").value(id).name("name").value(name).name("content").value(content).endObject()
                    writer.flush()
                    output.fd.sync()
                } finally { writer.close() }
                check(tempFile.renameTo(destination)) { "Could not replace private conflict draft" }
            }.onFailure { temporary?.delete() }
            withContext(Dispatchers.Main) {
                fail(
                    if (saved.isSuccess) "Reader edits conflicted with newer native content. A private recovery copy was saved."
                    else "Reader edits conflicted with newer native content, and the private recovery copy could not be written. Keep the reader draft open and copy it before continuing.",
                )
            }
        }
    }
}
