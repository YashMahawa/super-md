package dev.supermd.studio

import android.app.Application
import android.content.Context
import android.net.Uri
import android.os.Looper
import android.util.Base64
import androidx.lifecycle.ViewModelStore
import java.io.File; import java.nio.file.Files; import java.util.UUID
import kotlinx.coroutines.*
import org.json.JSONObject
import org.junit.*; import org.junit.Assert.*; import org.junit.runner.RunWith
import org.robolectric.*; import org.robolectric.Shadows.shadowOf; import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AgentPortableAssetCoordinatorTest {
    private val svgA = "<svg xmlns='http://www.w3.org/2000/svg'><circle r='4'/></svg>".toByteArray(Charsets.UTF_8)
    private val svgB = "<svg xmlns='http://www.w3.org/2000/svg'><rect width='6' height='6'/></svg>".toByteArray(Charsets.UTF_8)
    private lateinit var app: Application
    private lateinit var tempDir: File
    private lateinit var baselineDirs: Set<String>
    private var prevPrefs: Map<String, *>? = null
    private val stores = mutableListOf<ViewModelStore>()
    private val cleanups = mutableListOf<File>()

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication()
        tempDir = Files.createTempDirectory("agent-portable-coord-test").toFile().also(cleanups::add)
        baselineDirs = File(app.filesDir, "portable-assets").listFiles()?.map { it.name }?.toSet().orEmpty()
        val prefs = app.getSharedPreferences("studio", Context.MODE_PRIVATE)
        prevPrefs = HashMap(prefs.all)
        prefs.edit().putBoolean("autosave", false).commit()
    }

    @After fun tearDown() {
        stores.forEach { it.clear() }; shadowOf(Looper.getMainLooper()).idle()
        app.getSharedPreferences("studio", Context.MODE_PRIVATE).edit().apply {
            clear()
            prevPrefs?.forEach { (k, v) -> when (v) { is Boolean -> putBoolean(k, v); is String -> putString(k, v); is Int -> putInt(k, v); is Long -> putLong(k, v); is Float -> putFloat(k, v) } }
        }.commit()
        File(app.filesDir, "portable-assets").listFiles()?.forEach { if (it.name !in baselineDirs) it.deleteRecursively() }
        cleanups.forEach { it.deleteRecursively() }
    }

    @Test fun agentAssetActionListAndSourceReturnMetadataForMarkdownAndPortableNotes() {
        val model = newModel()
        val mdNote = model.state.value.active
        val mdList = runSuspend {
            model.agentAssetAction(JSONObject().put("tabId", mdNote.id).put("assetAction", "list").put("expectedRevision", agentContentRevision(mdNote.content)))
        }
        assertEquals(0, mdList.getInt("total"))
        assertEquals(0, mdList.getJSONArray("assets").length())
        assertEquals(agentContentRevision(mdNote.content), mdList.getString("revision"))

        val markdown = "# Study Note\n\n![Diagram](assets/diagram.svg)\n"
        val smdFile = File(tempDir, "Study.smd").also { out ->
            out.outputStream().use { model.media.writeFmd(it, markdown, JSONObject().put("assets/diagram.svg", "data:image/svg+xml;base64," + Base64.encodeToString(svgA, Base64.NO_WRAP))) }
        }
        awaitJob(model.open(Uri.fromFile(smdFile)))
        val portable = model.state.value.active
        val rev = agentContentRevision(markdown)
        val smdList = runSuspend { model.agentAssetAction(JSONObject().put("tabId", portable.id).put("assetAction", "list").put("expectedRevision", rev)) }
        assertEquals(1, smdList.getInt("total"))
        assertEquals("assets/diagram.svg", smdList.getJSONArray("assets").getJSONObject(0).getString("name"))
        assertEquals(rev, smdList.getString("revision"))
        val sourceRes = runSuspend { model.agentAssetAction(JSONObject().put("tabId", portable.id).put("assetAction", "source").put("assetName", "assets/diagram.svg").put("expectedRevision", rev)) }
        assertArrayEquals(svgA, Base64.decode(sourceRes.getString("body"), Base64.DEFAULT))
    }

    @Test fun agentAssetActionAttachEnforcesRevisionActiveTabAndSavedPortablePreconditions() {
        val model = newModel()
        var unsavedPortable: Note? = null
        model.newNote(titleHint = "Draft", format = "smd") { unsavedPortable = it }
        idleUntil { unsavedPortable != null && model.state.value.activeId == unsavedPortable!!.id }
        val draft = model.state.value.active
        val attachDraftReq = JSONObject().put("tabId", draft.id).put("assetAction", "attach")
            .put("assetName", "chart.svg").put("mimeType", "image/svg+xml")
            .put("body", Base64.encodeToString(svgB, Base64.NO_WRAP)).put("expectedRevision", agentContentRevision(draft.content))
        val unsavedErr = assertThrows(IllegalArgumentException::class.java) { runSuspend { model.agentAssetAction(attachDraftReq) } }
        assertEquals("Attaching an image requires a saved, unchanged portable .smd note", unsavedErr.message)

        val markdown = "# Saved Portable\n"
        val smdFile = File(tempDir, "Attach.smd").also { out -> out.outputStream().use { model.media.writeFmd(it, markdown, JSONObject()) } }
        awaitJob(model.open(Uri.fromFile(smdFile)))
        val savedId = model.state.value.active.id
        val rev = agentContentRevision(markdown)
        val staleErr = assertThrows(IllegalArgumentException::class.java) {
            runSuspend { model.agentAssetAction(JSONObject(attachDraftReq.toString()).put("tabId", savedId).put("expectedRevision", "0".repeat(64))) }
        }
        assertEquals("The document changed; read it again before using an asset", staleErr.message)

        model.select(draft.id); idleUntil { model.state.value.activeId == draft.id }
        val inactiveErr = assertThrows(IllegalArgumentException::class.java) {
            runSuspend { model.agentAssetAction(JSONObject(attachDraftReq.toString()).put("tabId", savedId).put("expectedRevision", rev)) }
        }
        assertEquals("Select the target tab before attaching its image", inactiveErr.message)

        model.select(savedId); idleUntil { model.state.value.activeId == savedId }
        val attached = runSuspend { model.agentAssetAction(JSONObject(attachDraftReq.toString()).put("tabId", savedId).put("expectedRevision", rev)) }
        assertTrue(attached.getBoolean("saved"))
        assertFalse(model.state.value.active.assetsDirty)
        assertArrayEquals(svgB, model.media.local("assets/chart.svg", model.state.value.active.assetDirectory)!!.readBytes())
    }

    @Test fun replacePortableAssetValidatesRevisionAndNoteStateAndReplacesSavedPortableImage() {
        val model = newModel()
        val importFile = File(app.filesDir, "attachments/import-${UUID.randomUUID()}.svg").apply { parentFile?.mkdirs(); writeBytes(svgB) }.also(cleanups::add)
        val mdNote = model.state.value.active
        val nonPortableErr = assertThrows(IllegalArgumentException::class.java) {
            runSuspend { model.replacePortableAsset(mdNote.id, "assets/fig.svg", "assets/${importFile.name}", agentContentRevision(mdNote.content)) }
        }
        assertEquals("Image replacement requires a saved, unchanged portable .smd note", nonPortableErr.message)

        val markdown = "# Portable\n\n![Fig](assets/fig.svg)\n"
        val smdFile = File(tempDir, "Replace.smd").also { out ->
            out.outputStream().use { model.media.writeFmd(it, markdown, JSONObject().put("assets/fig.svg", "data:image/svg+xml;base64," + Base64.encodeToString(svgA, Base64.NO_WRAP))) }
        }
        awaitJob(model.open(Uri.fromFile(smdFile)))
        val noteId = model.state.value.active.id
        val staleErr = assertThrows(IllegalArgumentException::class.java) {
            runSuspend { model.replacePortableAsset(noteId, "assets/fig.svg", "assets/${importFile.name}", "f".repeat(64)) }
        }
        assertEquals("The document changed; read it again before replacing an image", staleErr.message)

        val replaced = runSuspend { model.replacePortableAsset(noteId, "assets/fig.svg", "assets/${importFile.name}", agentContentRevision(markdown)) }
        assertTrue(replaced.getBoolean("saved") && replaced.getBoolean("changed"))
        assertArrayEquals(svgB, model.media.local("assets/fig.svg", model.state.value.active.assetDirectory)!!.readBytes())
    }

    private fun newModel() = StudioViewModel(app, "agent-coord-${System.nanoTime()}-${UUID.randomUUID()}".also {
        cleanups += File(app.filesDir, "workspaces/$it"); cleanups += File(app.filesDir, "workspaces/$it.json")
    }).also { it.readerFlushRequester = { true }; ViewModelStore().also(stores::add).put("m", it) }
    private fun awaitJob(job: Job) = idleUntil { job.isCompleted }
    private fun idleUntil(cond: () -> Boolean) {
        val end = System.currentTimeMillis() + 5_000
        while (System.currentTimeMillis() < end) { shadowOf(Looper.getMainLooper()).idle(); if (cond()) return; Thread.sleep(10) }
        assertTrue(cond())
    }
    private fun <T> runSuspend(block: suspend () -> T): T {
        var res: Result<T>? = null
        awaitJob(CoroutineScope(Dispatchers.Default).launch { res = runCatching { block() } })
        return res!!.getOrThrow()
    }
}
