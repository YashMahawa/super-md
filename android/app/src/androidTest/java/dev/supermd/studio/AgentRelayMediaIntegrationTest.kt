package dev.supermd.studio

import android.app.Application
import android.content.Intent
import android.net.Uri
import android.util.Base64
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class AgentRelayMediaIntegrationTest {
    @Test fun nativeRelayHandlerAttachesListsReturnsAndPatchesPortableSvgWithoutLosingDrafts() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        val workspace = UUID.randomUUID().toString()
        val noteFile = File(app.cacheDir, "relay-media-${UUID.randomUUID()}.smd")
        val media = MediaStorage(app)
        val originalMarkdown = "# Relay media\n"
        val originalSvg = "<svg xmlns='http://www.w3.org/2000/svg'><circle r='2'/></svg>".toByteArray()
        val modelSvg = "<svg xmlns='http://www.w3.org/2000/svg'><path d='M0 0L8 8'/></svg>".toByteArray()
        val initialAssets = JSONObject().put("assets/original.svg", media.portableImageData("image/svg+xml", originalSvg))
        noteFile.outputStream().use { media.writeFmd(it, originalMarkdown, initialAssets) }
        val uri = Uri.fromFile(noteFile)
        val launch = Intent(app, MainActivity::class.java).putExtra("workspace", workspace)
            .setDataAndType(uri, "application/octet-stream")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        val scenario = ActivityScenario.launch<MainActivity>(launch)
        var model: StudioViewModel? = null
        var originalAutosave: Boolean? = null
        val assetDirectories = mutableSetOf<String>()
        try {
            val handler = AtomicReference<((JSONObject, (Any?, String?) -> Unit) -> Unit)?>(null)
            scenario.onActivity { owner ->
                model = ViewModelProvider(owner)[StudioViewModel::class.java]
                originalAutosave = model!!.state.value.autosave
                model!!.reading(autosave = false)
            }
            waitUntil(20_000) {
                val current = model?.state?.value
                current?.autosave == false && current.active.uri == uri.toString() && current.active.content == originalMarkdown
            }
            waitUntil(20_000) {
                scenario.onActivity { owner ->
                    val field = MainActivity::class.java.getDeclaredField("agentBridgeHandler").apply { isAccessible = true }
                    @Suppress("UNCHECKED_CAST")
                    handler.set(field.get(owner) as? ((JSONObject, (Any?, String?) -> Unit) -> Unit))
                }
                handler.get() != null
            }
            val readerReady = AtomicReference<String?>(null)
            val evaluating = java.util.concurrent.atomic.AtomicBoolean(false)
            waitUntil(20_000) {
                if (readerReady.get() == "true") return@waitUntil true
                if (evaluating.compareAndSet(false, true)) scenario.onActivity { owner ->
                    findWebView(owner.window.decorView)?.evaluateJavascript(
                        "!!window.supermdAgentRequest && document.readyState === 'complete'",
                    ) { ready -> readerReady.set(ready); evaluating.set(false) } ?: run { evaluating.set(false) }
                }
                readerReady.get() == "true"
            }
            val note = model!!.state.value.active
            note.assetDirectory?.let(assetDirectories::add)
            assertTrue(note.portable)
            val revision = sha256(note.content)

            fun call(action: String, fields: JSONObject = JSONObject()): Pair<Any?, String?> {
                val latch = CountDownLatch(1)
                val result = AtomicReference<Pair<Any?, String?>>()
                val request = JSONObject(fields.toString()).put("requestId", "media_${UUID.randomUUID().toString().replace("-", "")}")
                    .put("action", action).put("tabId", note.id)
                scenario.onActivity {
                    handler.get()!!.invoke(request) { value, error -> result.set(value to error); latch.countDown() }
                }
                assertTrue("Native relay handler did not reply to $action", latch.await(20, TimeUnit.SECONDS))
                return result.get()
            }

            val attached = call("asset_action", JSONObject().put("assetAction", "attach")
                .put("assetName", "assets/model.svg").put("mimeType", "image/svg+xml")
                .put("body", Base64.encodeToString(modelSvg, Base64.NO_WRAP)).put("expectedRevision", revision))
            assertNull(attached.second)
            assertEquals("assets/model.svg", (attached.first as JSONObject).getString("assetName"))
            assertFalse(model!!.state.value.active.dirty)
            assertEquals(originalMarkdown, model!!.state.value.active.content)
            model!!.state.value.active.assetDirectory?.let(assetDirectories::add)

            val listed = call("asset_action", JSONObject().put("assetAction", "list").put("expectedRevision", revision))
            assertNull(listed.second)
            val listResult = listed.first as JSONObject
            assertEquals(2, listResult.getInt("total"))
            val assetNames = (0 until listResult.getJSONArray("assets").length()).map { listResult.getJSONArray("assets").getJSONObject(it).getString("name") }.toSet()
            assertEquals(setOf("assets/original.svg", "assets/model.svg"), assetNames)

            val source = call("asset_action", JSONObject().put("assetAction", "source")
                .put("assetName", "assets/model.svg").put("expectedRevision", revision))
            assertNull(source.second)
            assertArrayEquals(modelSvg, Base64.decode((source.first as JSONObject).getString("body"), Base64.DEFAULT))

            val patch = JSONObject().put("expectedRevision", revision).put("operations", JSONArray().put(
                JSONObject().put("type", "replace").put("old", "# Relay media")
                    .put("new", "# Relay media\n\n![Model](assets/model.svg)")))
            val patched = call("patch_tab", patch)
            assertNull(patched.second)
            waitUntil(10_000) { model!!.state.value.active.content.contains("![Model](assets/model.svg)") }
            assertTrue(model!!.state.value.active.dirty)
            assertEquals(originalMarkdown, model!!.state.value.active.saved)
            val afterPatch = model!!.state.value.active
            val retained = media.portableAssets(afterPatch.assetDirectory)
            assertEquals(2, retained.length())
            assertArrayEquals(originalSvg, media.decodePortableImage(retained.getString("assets/original.svg")).second)
            assertArrayEquals(modelSvg, media.decodePortableImage(retained.getString("assets/model.svg")).second)

            val stale = call("asset_action", JSONObject().put("assetAction", "attach")
                .put("assetName", "assets/stale.svg").put("mimeType", "image/svg+xml")
                .put("body", Base64.encodeToString(modelSvg, Base64.NO_WRAP)).put("expectedRevision", revision))
            assertNull(stale.first)
            assertTrue(stale.second.orEmpty().contains("changed"))
            assertTrue(model!!.state.value.active.content.contains("![Model](assets/model.svg)"))
            assertTrue(model!!.state.value.active.dirty)

            val onDisk = noteFile.inputStream().use(media::openFmd)
            try {
                assertEquals(originalMarkdown, onDisk.markdown)
                val diskAssets = media.portableAssets(onDisk.directory)
                assertEquals(2, diskAssets.length())
                assertArrayEquals(originalSvg, media.decodePortableImage(diskAssets.getString("assets/original.svg")).second)
                assertArrayEquals(modelSvg, media.decodePortableImage(diskAssets.getString("assets/model.svg")).second)
            } finally { File(app.filesDir, "portable-assets/${onDisk.directory}").deleteRecursively() }
        } finally {
            originalAutosave?.let { autosave -> runCatching { scenario.onActivity { model?.reading(autosave = autosave) } } }
            runCatching { scenario.onActivity { model?.state?.value?.tabs?.mapNotNull { it.assetDirectory }?.let(assetDirectories::addAll) } }
            scenario.close()
            assetDirectories.forEach { File(app.filesDir, "portable-assets/$it").deleteRecursively() }
            noteFile.delete()
            File(app.filesDir, "workspaces/$workspace.json").delete()
            File(app.filesDir, "workspaces/$workspace").deleteRecursively()
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

    private fun findWebView(view: android.view.View): android.webkit.WebView? = when (view) {
        is android.webkit.WebView -> view
        is android.view.ViewGroup -> (0 until view.childCount).firstNotNullOfOrNull { findWebView(view.getChildAt(it)) }
        else -> null
    }

    private fun sha256(text: String): String = MessageDigest.getInstance("SHA-256")
        .digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
}
