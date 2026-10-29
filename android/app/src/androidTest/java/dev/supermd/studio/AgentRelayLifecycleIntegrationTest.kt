package dev.supermd.studio

import android.app.Application
import android.content.Intent
import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.runBlocking

@RunWith(AndroidJUnit4::class)
class AgentRelayLifecycleIntegrationTest {
    @Test fun completedPortableExportDownloadsBoundedChunksWithRealEmbeddedAssetBytes() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        val workspace = UUID.randomUUID().toString()
        val jobId = "download_${UUID.randomUUID().toString().replace("-", "")}"
        val svg = "<svg xmlns='http://www.w3.org/2000/svg'><path d='M1 2'/></svg>".toByteArray()
        val media = MediaStorage(app)
        val export = File(app.cacheDir, "agent-export-${UUID.randomUUID()}.smd")
        val emptyMarkdown = File(app.cacheDir, "agent-export-${UUID.randomUUID()}.md").apply { writeBytes(byteArrayOf()) }
        export.outputStream().use { media.writeFmd(it, "# Downloaded portable note\n", JSONObject().put("assets/photo.svg", media.portableImageData("image/svg+xml", svg))) }
        val scenario = ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java).putExtra("workspace", workspace))
        val handler = AtomicReference<((JSONObject, (Any?, String?) -> Unit) -> Unit)?>(null)
        val ownerRef = AtomicReference<MainActivity?>(null)
        var extractedDirectory: String? = null
        try {
            awaitBridge(scenario, handler)
            scenario.onActivity { owner ->
                ownerRef.set(owner)
                owner.setAgentExportHandler { }
                owner.requestAgentExport(JSONObject().put("requestId", jobId).put("expectedRevision", "a".repeat(64)))
                owner.updateAgentExportJob(jobId, "preparing")
            }
            runBlocking { ownerRef.get()!!.completeAgentExport(jobId, Uri.fromFile(export), "fallback.smd", "smd") }
            scenario.onActivity { owner ->
                val status = owner.agentExportJob(jobId)!!
                assertEquals("completed", status.getString("phase"))
                assertTrue(status.getBoolean("downloadable"))
                assertFalse("The destination URI stays private to the app", status.has("uri"))
                assertEquals(export.length(), status.getLong("bytes"))
            }

            val assembled = ByteArrayOutputStream()
            var offset = 0L
            while (true) {
                val (raw, error) = call(scenario, handler, "document_action", JSONObject()
                    .put("documentAction", "export_chunk").put("jobId", jobId).put("offset", offset).put("limit", 113))
                assertNull(error)
                val chunk = raw as JSONObject
                val body = android.util.Base64.decode(chunk.getString("body"), android.util.Base64.DEFAULT)
                assertTrue(body.size <= 113)
                assertEquals(offset, chunk.getLong("offset"))
                assertEquals(export.length(), chunk.getLong("bytes"))
                assembled.write(body)
                if (chunk.isNull("nextOffset")) break
                offset = chunk.getLong("nextOffset")
            }
            val downloadedBytes = assembled.toByteArray()
            assertArrayEquals(export.readBytes(), downloadedBytes)
            scenario.onActivity { owner ->
                val downloaded = owner.agentExportJob(jobId)!!
                assertEquals(sha256(downloadedBytes), downloaded.getString("sha256"))
            }
            val opened = downloadedBytes.inputStream().use(media::openFmd)
            extractedDirectory = opened.directory
            val downloadedAsset = media.decodePortableImage(media.portableAssets(opened.directory).getString("assets/photo.svg")).second
            assertArrayEquals("The downloaded portable file contains the original image bytes", svg, downloadedAsset)

            val emptyJobId = "empty_${UUID.randomUUID().toString().replace("-", "")}"
            scenario.onActivity { owner ->
                owner.requestAgentExport(JSONObject().put("requestId", emptyJobId).put("expectedRevision", "a".repeat(64)))
                owner.updateAgentExportJob(emptyJobId, "saving")
            }
            runBlocking { ownerRef.get()!!.completeAgentExport(emptyJobId, Uri.fromFile(emptyMarkdown), "empty.md", "md") }
            scenario.onActivity { owner ->
                val status = owner.agentExportJob(emptyJobId)!!
                assertEquals("completed", status.getString("status"))
                assertEquals(0L, status.getLong("bytes"))
                assertEquals(sha256(byteArrayOf()), status.getString("sha256"))
                assertFalse("Job metadata must not expose the destination URI", status.has("uri"))
                assertFalse("Job metadata must not expose a filesystem path", status.has("path"))
            }
            val emptyChunk = call(scenario, handler, "document_action", JSONObject().put("documentAction", "export_chunk")
                .put("jobId", emptyJobId).put("offset", 0).put("limit", 113))
            assertNull(emptyChunk.second)
            assertEquals("", (emptyChunk.first as JSONObject).getString("body"))
            assertEquals(0L, (emptyChunk.first as JSONObject).getLong("bytes"))
            assertTrue((emptyChunk.first as JSONObject).isNull("nextOffset"))
            assertFalse((emptyChunk.first as JSONObject).has("uri"))
            assertFalse((emptyChunk.first as JSONObject).has("path"))

            val unknown = call(scenario, handler, "document_action", JSONObject().put("documentAction", "export_chunk")
                .put("jobId", "unregistered_job").put("offset", 0).put("limit", 113))
            assertNull(unknown.first)
            assertTrue(unknown.second.orEmpty().contains("completed export"))
        } finally {
            extractedDirectory?.let { File(app.filesDir, "portable-assets/$it").deleteRecursively() }
            scenario.close()
            export.delete()
            emptyMarkdown.delete()
            File(app.filesDir, "workspaces/$workspace.json").delete()
            File(app.filesDir, "workspaces/$workspace").deleteRecursively()
        }
    }

    @Test fun backgroundCreateInactivePatchActivateAndRevisionGuardedClosePreserveRecovery() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        val workspace = UUID.randomUUID().toString()
        val scenario = ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java).putExtra("workspace", workspace))
        var model: StudioViewModel? = null
        var originalAutosave: Boolean? = null
        val assetDirectories = mutableSetOf<String>()
        val handler = AtomicReference<((JSONObject, (Any?, String?) -> Unit) -> Unit)?>(null)
        try {
            scenario.onActivity { owner ->
                model = ViewModelProvider(owner)[StudioViewModel::class.java]
                originalAutosave = model!!.state.value.autosave
                model!!.reading(autosave = false)
            }
            waitUntil(20_000) { model?.state?.value?.autosave == false && model?.state?.value?.tabs?.isNotEmpty() == true }
            awaitBridge(scenario, handler)
            val initial = model!!.state.value.active
            assertEquals(initial.id, model!!.state.value.activeId)
            val focusContent = "# Agent focus fixture\n\nVisible focused paragraph with emoji 😀 and math \$E = mc^2\$.\n\n```svg\n<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"12\" height=\"12\"><rect width=\"12\" height=\"12\" fill=\"#3478f6\"/></svg>\n```\n"
            scenario.onActivity { model!!.edit(initial.id, focusContent) }
            waitUntil(20_000) {
                readerJavascript(scenario, """(()=>{const a=document.querySelector('.markdown-body'),i=a?.querySelector('.svg-diagram');if(!a?.innerText.includes('Visible focused paragraph with emoji 😀')||!i?.complete||document.fonts.status!=='loaded')return false;if(window.__agentLifecycleFixtureStable===undefined){window.__agentLifecycleFixtureStable=false;requestAnimationFrame(()=>requestAnimationFrame(()=>window.__agentLifecycleFixtureStable=true));return false}return window.__agentLifecycleFixtureStable===true})()""") == "true"
            }
            assertTrue("Reader did not acknowledge the focused fixture", runBlocking { model!!.readerFlushRequester?.invoke(initial.id) == true })
            assertEquals(focusContent, model!!.state.value.tabs.first { it.id == initial.id }.content)
            val visibleDraft = evaluateReaderText(scenario)
            assertTrue("Lifecycle test needs visible reader content", visibleDraft.length > 2)

            val created = call(scenario, handler, "document_action", JSONObject()
                .put("documentAction", "create").put("content", "😀 # Before patch\n")
                .put("options", JSONObject().put("title", "Background draft").put("format", "md").put("background", true)))
            assertNull(created.second)
            val createResult = created.first as JSONObject
            val background = model!!.state.value.tabs.first { it.name == "Background draft.md" }
            assertFalse(createResult.getBoolean("active"))
            assertEquals(initial.id, model!!.state.value.activeId)
            assertEquals("Background creation must preserve the focused reader draft", visibleDraft, evaluateReaderText(scenario))
            val baseRevision = sha256(background.content)

            val read = call(scenario, handler, "read_tab", JSONObject().put("tabId", background.id)
                .put("offset", 0).put("limit", 100))
            assertNull(read.second)
            val readResult = read.first as JSONObject
            assertEquals(baseRevision, readResult.getString("revision"))
            assertEquals(background.content.codePointCount(0, background.content.length), readResult.getInt("sourceLength"))
            assertEquals(initial.id, model!!.state.value.activeId)

            val patch = call(scenario, handler, "patch_tab", JSONObject().put("tabId", background.id)
                .put("expectedRevision", baseRevision).put("operations", JSONArray().put(JSONObject()
                    .put("type", "replace").put("old", "Before patch").put("new", "After patch 🚀"))))
            assertNull(patch.second)
            val patchResult = patch.first as JSONObject
            val patchedNote = model!!.state.value.tabs.first { it.id == background.id }
            assertTrue(patchedNote.content.contains("After patch 🚀"))
            assertEquals(patchedNote.content.codePointCount(0, patchedNote.content.length), patchResult.getInt("sourceLength"))
            assertEquals(initial.id, model!!.state.value.activeId)
            assertEquals("Inactive patching must not replace the focused reader draft", visibleDraft, evaluateReaderText(scenario))

            val staleRead = call(scenario, handler, "read_tab", JSONObject().put("tabId", background.id)
                .put("expectedRevision", baseRevision))
            assertNull(staleRead.first)
            val conflict = JSONObject(staleRead.second!!)
            assertEquals(sha256(model!!.state.value.tabs.first { it.id == background.id }.content), conflict.getString("currentRevision"))
            val conflictedNote = model!!.state.value.tabs.first { it.id == background.id }
            assertEquals(conflictedNote.content.codePointCount(0, conflictedNote.content.length), conflict.getInt("sourceLength"))

            val staleClose = call(scenario, handler, "document_action", JSONObject().put("documentAction", "close")
                .put("tabId", background.id).put("expectedRevision", baseRevision).put("options", JSONObject().put("discardChanges", true)))
            assertNull(staleClose.first)
            val closeConflict = JSONObject(staleClose.second!!)
            assertEquals(patchResult.getString("revision"), closeConflict.getString("currentRevision"))
            assertTrue(model!!.state.value.tabs.any { it.id == background.id })

            val activated = call(scenario, handler, "document_action", JSONObject().put("documentAction", "activate").put("tabId", background.id))
            assertNull(activated.second)
            assertEquals(background.id, model!!.state.value.activeId)

            val refusedClose = call(scenario, handler, "document_action", JSONObject().put("documentAction", "close")
                .put("tabId", background.id).put("expectedRevision", patchResult.getString("revision")))
            assertNull(refusedClose.first)
            assertTrue(refusedClose.second.orEmpty().contains("unsaved changes"))
            assertTrue(model!!.state.value.tabs.any { it.id == background.id })

            val closed = call(scenario, handler, "document_action", JSONObject().put("documentAction", "close")
                .put("tabId", background.id).put("expectedRevision", patchResult.getString("revision"))
                .put("options", JSONObject().put("discardChanges", true)))
            assertNull(closed.second)
            assertTrue((closed.first as JSONObject).getBoolean("closed"))
            assertFalse(model!!.state.value.tabs.any { it.id == background.id })
            assertTrue(model!!.state.value.closedTabs.any { it.id == background.id })

            val portableCreated = call(scenario, handler, "document_action", JSONObject().put("documentAction", "create")
                .put("content", "# Portable format\n").put("options", JSONObject().put("title", "Background portable")
                    .put("filename", "ignored.md").put("format", "smd").put("background", true)))
            assertNull(portableCreated.second)
            val portableNote = model!!.state.value.tabs.first { it.name == "Background portable.smd" }
            assetDirectories += portableNote.assetDirectory!!
            assertTrue((portableCreated.first as JSONObject).getBoolean("active").not())
            assertEquals("smd", (portableCreated.first as JSONObject).getString("format"))
            assertTrue(portableNote.portable)
            assertEquals(initial.id, model!!.state.value.activeId)
            val portableClose = call(scenario, handler, "document_action", JSONObject().put("documentAction", "close")
                .put("tabId", portableNote.id).put("expectedRevision", sha256(portableNote.content)).put("options", JSONObject().put("discardChanges", true)))
            assertNull(portableClose.second)
            assertTrue((portableClose.first as JSONObject).getBoolean("closed"))
        } finally {
            originalAutosave?.let { autosave -> runCatching { scenario.onActivity { model?.reading(autosave = autosave) } } }
            runCatching { scenario.onActivity { model?.state?.value?.let { state -> (state.tabs + state.closedTabs).mapNotNull { it.assetDirectory }.let(assetDirectories::addAll) } } }
            scenario.close()
            assetDirectories.forEach { File(app.filesDir, "portable-assets/$it").deleteRecursively() }
            File(app.filesDir, "workspaces/$workspace.json").delete()
            File(app.filesDir, "workspaces/$workspace").deleteRecursively()
        }
    }

    @Test fun portableSaveAsRoundTripsAssetsAndInPlaceSaveRefusesExternalAssetChanges() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        val workspace = UUID.randomUUID().toString()
        val markdown = "# Portable cloud note\n"
        val sourceSvg = "<svg xmlns='http://www.w3.org/2000/svg'><circle r='2'/></svg>".toByteArray()
        val externalSvg = "<svg xmlns='http://www.w3.org/2000/svg'><path d='M1 1'/></svg>".toByteArray()
        val media = MediaStorage(app)
        val input = File(app.cacheDir, "portable-save-${UUID.randomUUID()}.smd")
        input.outputStream().use { media.writeFmd(it, markdown, JSONObject().put("assets/original.svg", media.portableImageData("image/svg+xml", sourceSvg))) }
        val scenario = ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java).putExtra("workspace", workspace)
            .setDataAndType(Uri.fromFile(input), "application/octet-stream")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION))
        var model: StudioViewModel? = null
        var originalAutosave: Boolean? = null
        val handler = AtomicReference<((JSONObject, (Any?, String?) -> Unit) -> Unit)?>(null)
        var outputUri: Uri? = null
        val assetDirectories = mutableSetOf<String>()
        val prefs = app.getSharedPreferences("studio", 0)
        val previousNoteLocation = prefs.getString("newNoteLocation", null)
        try {
            scenario.onActivity { owner ->
                model = ViewModelProvider(owner)[StudioViewModel::class.java]
                originalAutosave = model!!.state.value.autosave
                model!!.reading(autosave = false)
            }
            waitUntil(20_000) { model?.state?.value?.autosave == false && model?.state?.value?.active?.uri == Uri.fromFile(input).toString() }
            awaitBridge(scenario, handler)
            val note = model!!.state.value.active
            assertTrue(note.portable)
            prefs.edit().remove("newNoteLocation").commit()

            val savedAs = call(scenario, handler, "document_action", JSONObject().put("documentAction", "save")
                .put("tabId", note.id).put("expectedRevision", sha256(note.content))
                .put("options", JSONObject().put("saveAs", true).put("filename", "Agent portable.smd").put("format", "smd")))
            assertNull(savedAs.second)
            val saveResult = savedAs.first as JSONObject
            assertTrue(saveResult.getBoolean("savedAs"))
            outputUri = Uri.parse(saveResult.getString("uri"))
            assertEquals(outputUri.toString(), model!!.state.value.active.uri)
            assertTrue(outputUri.toString().startsWith("content://"))

            val baselineBytes = app.contentResolver.openInputStream(outputUri!!)?.use { it.readBytes() } ?: error("Save As output unavailable")
            val baseline = baselineBytes.inputStream().use(media::openFmd)
            assetDirectories += baseline.directory
            assertEquals(markdown, baseline.markdown)
            assertArrayEquals(sourceSvg, media.decodePortableImage(media.portableAssets(baseline.directory).getString("assets/original.svg")).second)

            val patchResult = call(scenario, handler, "patch_tab", JSONObject().put("tabId", note.id)
                .put("expectedRevision", sha256(note.content)).put("operations", JSONArray().put(JSONObject()
                    .put("type", "replace").put("old", "Portable cloud note").put("new", "Updated portable note"))))
            assertNull(patchResult.second)
            val updated = model!!.state.value.active
            val updatedRevision = sha256(updated.content)
            assertEquals(patchResult.first.asJson().getString("revision"), updatedRevision)

            val externalBytes = ByteArrayOutputStream().also { output ->
                media.writeFmd(output, markdown, JSONObject().put("assets/original.svg", media.portableImageData("image/svg+xml", externalSvg)))
            }.toByteArray()
            app.contentResolver.openOutputStream(outputUri!!, "wt")!!.use { it.write(externalBytes) }
            val refused = call(scenario, handler, "document_action", JSONObject().put("documentAction", "save")
                .put("tabId", note.id).put("expectedRevision", updatedRevision))
            assertNull(refused.first)
            assertTrue(refused.second.orEmpty().contains("changed on disk"))
            assertArrayEquals("External bytes must survive the refused save", externalBytes,
                app.contentResolver.openInputStream(outputUri!!)?.use { it.readBytes() })

            app.contentResolver.openOutputStream(outputUri!!, "wt")!!.use { it.write(baselineBytes) }
            val inPlace = call(scenario, handler, "document_action", JSONObject().put("documentAction", "save")
                .put("tabId", note.id).put("expectedRevision", updatedRevision))
            assertNull(inPlace.second)
            assertTrue((inPlace.first as JSONObject).getBoolean("saved"))
            assertEquals(outputUri.toString(), (inPlace.first as JSONObject).getString("path"))
            val finalBytes = app.contentResolver.openInputStream(outputUri!!)?.use { it.readBytes() } ?: error("Saved output disappeared")
            val finalFmd = finalBytes.inputStream().use(media::openFmd)
            assetDirectories += finalFmd.directory
            assertEquals(updated.content, finalFmd.markdown)
            assertArrayEquals(sourceSvg, media.decodePortableImage(media.portableAssets(finalFmd.directory).getString("assets/original.svg")).second)
        } finally {
            originalAutosave?.let { autosave -> runCatching { scenario.onActivity { model?.reading(autosave = autosave) } } }
            if (previousNoteLocation != null) prefs.edit().putString("newNoteLocation", previousNoteLocation).commit()
            else prefs.edit().remove("newNoteLocation").commit()
            outputUri?.let { uri -> runCatching { app.contentResolver.delete(uri, null, null) } }
            assetDirectories.forEach { File(app.filesDir, "portable-assets/$it").deleteRecursively() }
            runCatching { scenario.onActivity { model?.state?.value?.tabs?.mapNotNull { it.assetDirectory }?.forEach { File(app.filesDir, "portable-assets/$it").deleteRecursively() } } }
            scenario.close()
            input.delete()
            File(app.filesDir, "workspaces/$workspace.json").delete()
            File(app.filesDir, "workspaces/$workspace").deleteRecursively()
        }
    }

    private fun call(
        scenario: ActivityScenario<MainActivity>,
        handler: AtomicReference<((JSONObject, (Any?, String?) -> Unit) -> Unit)?>,
        action: String,
        fields: JSONObject,
    ): Pair<Any?, String?> {
        val latch = CountDownLatch(1)
        val result = AtomicReference<Pair<Any?, String?>>()
        val request = JSONObject(fields.toString()).put("requestId", "lifecycle_${UUID.randomUUID().toString().replace("-", "")}")
            .put("action", action)
        AgentRelayClient().validateRequest(request)
        scenario.onActivity { handler.get()!!.invoke(request) { value, error -> result.set(value to error); latch.countDown() } }
        assertTrue("Native relay handler did not reply to $action", latch.await(20, TimeUnit.SECONDS))
        return result.get()
    }

    private fun awaitBridge(
        scenario: ActivityScenario<MainActivity>,
        handler: AtomicReference<((JSONObject, (Any?, String?) -> Unit) -> Unit)?>,
    ) {
        waitUntil(20_000) {
            scenario.onActivity { owner ->
                val field = MainActivity::class.java.getDeclaredField("agentBridgeHandler").apply { isAccessible = true }
                @Suppress("UNCHECKED_CAST")
                handler.set(field.get(owner) as? ((JSONObject, (Any?, String?) -> Unit) -> Unit))
            }
            handler.get() != null
        }
        val ready = AtomicReference<String?>(null)
        val evaluating = AtomicBoolean(false)
        waitUntil(20_000) {
            if (ready.get() == "true") return@waitUntil true
            if (evaluating.compareAndSet(false, true)) scenario.onActivity { owner ->
                findWebView(owner.window.decorView)?.evaluateJavascript(
                    "!!window.supermdAgentRequest && !!window.supermdAgentCompute && document.readyState === 'complete'",
                ) { value -> ready.set(value); evaluating.set(false) } ?: run { evaluating.set(false) }
            }
            ready.get() == "true"
        }
    }

    private fun waitUntil(timeoutMs: Long, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (!condition() && System.currentTimeMillis() < deadline) {
            androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            Thread.sleep(20)
        }
        assertTrue("Condition timed out", condition())
    }

    private fun evaluateReaderText(scenario: ActivityScenario<MainActivity>): String {
        return readerJavascript(scenario, "document.querySelector('.markdown-body')?.innerText ?? document.querySelector('.cm-content')?.textContent ?? ''")
    }

    private fun readerJavascript(scenario: ActivityScenario<MainActivity>, script: String): String {
        val reply = AtomicReference<String?>(null)
        val latch = CountDownLatch(1)
        scenario.onActivity { owner ->
            findWebView(owner.window.decorView)?.evaluateJavascript(script) { value -> reply.set(value); latch.countDown() }
                ?: latch.countDown()
        }
        assertTrue("Reader did not return its visible document text", latch.await(10, TimeUnit.SECONDS))
        return requireNotNull(reply.get()) { "Reader WebView was unavailable" }
    }

    private fun findWebView(view: View): WebView? = when (view) {
        is WebView -> view
        is ViewGroup -> (0 until view.childCount).firstNotNullOfOrNull { findWebView(view.getChildAt(it)) }
        else -> null
    }

    private fun Any?.asJson(): JSONObject = this as? JSONObject ?: JSONObject(this.toString())
    private fun sha256(text: String): String = MessageDigest.getInstance("SHA-256")
        .digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(bytes).joinToString("") { "%02x".format(it) }
}
