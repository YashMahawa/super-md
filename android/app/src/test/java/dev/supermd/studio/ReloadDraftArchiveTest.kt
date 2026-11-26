package dev.supermd.studio

import android.app.Application
import android.net.Uri
import android.os.Looper
import android.util.Base64
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.time.Duration
import java.util.UUID
import javax.imageio.ImageIO
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ReloadDraftArchiveTest {
    private fun makePngDataUrl(rgb: Int): String {
        val image = BufferedImage(2, 2, BufferedImage.TYPE_INT_ARGB).apply {
            setRGB(0, 0, rgb)
            setRGB(1, 1, rgb)
        }
        val bytes = ByteArrayOutputStream().also { ImageIO.write(image, "png", it) }.toByteArray()
        return "data:image/png;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
    }

    private val pngDraft = makePngDataUrl(0xFF1E88E5.toInt())
    private val pngDisk = makePngDataUrl(0xFFD81B60.toInt())

    private fun waitUntil(timeoutMs: Long = 5_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        val mainLooper = shadowOf(Looper.getMainLooper())
        while (System.currentTimeMillis() < deadline) {
            mainLooper.idleFor(Duration.ofMillis(50))
            if (condition()) return
            Thread.sleep(15)
        }
        mainLooper.idleFor(Duration.ofMillis(50))
        assertTrue("Timed out waiting for condition", condition())
    }

    private fun createViewModel(app: Application, key: String): Pair<androidx.lifecycle.ViewModelStore, StudioViewModel> {
        val store = androidx.lifecycle.ViewModelStore()
        val factory = object : androidx.lifecycle.ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : androidx.lifecycle.ViewModel> create(modelClass: Class<T>): T =
                StudioViewModel(app, workspaceKey = key) as T
        }
        val model = androidx.lifecycle.ViewModelProvider(store, factory)[StudioViewModel::class.java]
        model.reading(autosave = false)
        return store to model
    }

    private fun withWorkspace(block: (Application, File, String, StudioViewModel) -> Unit) {
        val app = RuntimeEnvironment.getApplication()
        val temp = Files.createTempDirectory("reload-archive-test").toFile()
        val key = "test-${UUID.randomUUID()}"
        val (store, model) = createViewModel(app, key)
        try {
            block(app, temp, key, model)
        } finally {
            store.clear()
            File(app.filesDir, "workspaces/$key.json").deleteRecursively()
            File(app.filesDir, "workspaces/$key").deleteRecursively()
            temp.deleteRecursively()
        }
    }

    @Test
    fun reloadFromDiskArchivesDirtyMarkdownAndPortableDraftWithAssetsAndSurvivesRestart() = withWorkspace { app, temp, key, model ->
        // 1. Dirty Markdown draft is archived before Reload from disk and can be reopened alongside the reloaded tab.
        val mdFile = File(temp, "Draft.md").apply { writeText("# Disk v1\n", Charsets.UTF_8) }
        model.open(Uri.fromFile(mdFile))
        waitUntil { model.state.value.active.uri == Uri.fromFile(mdFile).toString() }
        val mdId = model.state.value.active.id

        model.edit(mdId, "# Unsaved local prose\n\nKeep me safe.\n")
        mdFile.writeText("# Disk v2\n", Charsets.UTF_8)
        model.refreshExternal()
        waitUntil { model.state.value.activeConflicted }

        model.reloadFromDisk(mdId)
        waitUntil { !model.state.value.activeConflicted && !model.state.value.active.dirty && model.state.value.active.content == "# Disk v2\n" }
        assertEquals(1, model.state.value.closedTabs.size)
        assertEquals("Recovered Draft.md", model.state.value.closedTabs.first().name)

        val tabsBeforeReopen = model.state.value.tabs.size
        model.reopen()
        waitUntil { model.state.value.tabs.size == tabsBeforeReopen + 1 && model.state.value.active.name == "Recovered Draft.md" }
        val reopenedMd = model.state.value.active
        assertNotEquals(mdId, reopenedMd.id)
        assertEquals(null, reopenedMd.uri)
        assertEquals("# Unsaved local prose\n\nKeep me safe.\n", reopenedMd.content)
        assertTrue(reopenedMd.dirty)
        assertEquals("# Disk v2\n", mdFile.readText(Charsets.UTF_8))

        // Clean reload does not append duplicate closed-tab snapshots.
        model.select(mdId)
        waitUntil { model.state.value.active.id == mdId }
        val closedBeforeClean = model.state.value.closedTabs
        mdFile.writeText("# Disk v3\n", Charsets.UTF_8)
        model.reloadFromDisk(mdId)
        waitUntil { model.state.value.active.content == "# Disk v3\n" }
        assertEquals(closedBeforeClean, model.state.value.closedTabs)

        // 2. Dirty portable .smd draft preserves both markdown and portable-assets across Reload from disk AND restart.
        val smdFile = File(temp, "Notebook.smd")
        smdFile.outputStream().use { out ->
            model.media.writeFmd(out, "# Portable v1\n\n![plot](assets/plot.png)\n", JSONObject().put("assets/plot.png", pngDraft))
        }
        model.open(Uri.fromFile(smdFile))
        waitUntil { model.state.value.active.uri == Uri.fromFile(smdFile).toString() }
        val smdId = model.state.value.active.id
        val draftAssetDir = model.state.value.active.assetDirectory
        assertNotNull(draftAssetDir)

        model.edit(smdId, "# Portable local draft\n\n![plot](assets/plot.png)\n")
        model.markAssetsDirty(smdId)
        smdFile.outputStream().use { out ->
            model.media.writeFmd(out, "# Portable disk v2\n\n![plot](assets/plot.png)\n", JSONObject().put("assets/plot.png", pngDisk))
        }
        model.refreshExternal()
        waitUntil { model.state.value.activeConflicted }

        model.reloadFromDisk(smdId)
        waitUntil {
            !model.state.value.activeConflicted &&
                !model.state.value.active.dirty &&
                model.state.value.active.content.startsWith("# Portable disk v2")
        }
        val reloadedAssetDir = model.state.value.active.assetDirectory
        assertNotNull(reloadedAssetDir)
        assertNotEquals(draftAssetDir, reloadedAssetDir)
        assertEquals(pngDisk, model.media.portableAssets(reloadedAssetDir).getString("assets/plot.png"))
        // Pre-reload portable-assets directory must NOT be deleted because ClosedNoteStore references it.
        assertTrue(File(app.filesDir, "portable-assets/$draftAssetDir").isDirectory)
        assertEquals(pngDraft, model.media.portableAssets(draftAssetDir).getString("assets/plot.png"))

        runBlocking { model.flushRecoveryAndAwait() }

        // Simulate app restart on the same workspace key and verify reopen restores draft + portable assets.
        val (restartedStore, restartedModel) = createViewModel(app, key)
        try {
            assertEquals("Recovered Notebook.smd", restartedModel.state.value.closedTabs.firstOrNull()?.name)
            restartedModel.reopen()
            waitUntil { restartedModel.state.value.active.name == "Recovered Notebook.smd" }
            val recoveredPortable = restartedModel.state.value.active
            assertEquals("# Portable local draft\n\n![plot](assets/plot.png)\n", recoveredPortable.content)
            assertTrue(recoveredPortable.portable)
            assertTrue(recoveredPortable.dirty)
            assertEquals(pngDraft, restartedModel.media.portableAssets(recoveredPortable.assetDirectory).getString("assets/plot.png"))
        } finally {
            restartedStore.clear()
            File(app.filesDir, "portable-assets/$draftAssetDir").deleteRecursively()
            File(app.filesDir, "portable-assets/$reloadedAssetDir").deleteRecursively()
        }
    }

    @Test
    fun failedArchiveOrFailedReloadKeepsDirtyDraftAndPortableAssetsRecoverable() = withWorkspace { app, temp, key, model ->
        val smdFile = File(temp, "Critical.smd")
        smdFile.outputStream().use { out ->
            model.media.writeFmd(out, "# Initial\n\n![plot](assets/plot.png)\n", JSONObject().put("assets/plot.png", pngDraft))
        }
        model.open(Uri.fromFile(smdFile))
        waitUntil { model.state.value.active.uri == Uri.fromFile(smdFile).toString() }
        val smdId = model.state.value.active.id
        val draftAssetDir = model.state.value.active.assetDirectory
        assertNotNull(draftAssetDir)

        model.edit(smdId, "# Unsaved critical draft\n\n![plot](assets/plot.png)\n")
        smdFile.outputStream().use { out ->
            model.media.writeFmd(out, "# External update\n\n![plot](assets/plot.png)\n", JSONObject().put("assets/plot.png", pngDisk))
        }
        model.refreshExternal()
        waitUntil { model.state.value.activeConflicted }

        // 1. Block ClosedNoteStore directory with a regular file so archiving fails.
        val closedDir = File(app.filesDir, "workspaces/$key/closed-notes")
        closedDir.deleteRecursively()
        closedDir.parentFile!!.mkdirs()
        closedDir.writeText("blocked-by-file", Charsets.UTF_8)

        model.reloadFromDisk(smdId)
        waitUntil { model.state.value.error?.contains("Could not archive draft before reloading") == true }
        assertEquals("# Unsaved critical draft\n\n![plot](assets/plot.png)\n", model.state.value.active.content)
        assertEquals(draftAssetDir, model.state.value.active.assetDirectory)
        assertTrue(model.state.value.activeConflicted)
        assertTrue(File(app.filesDir, "portable-assets/$draftAssetDir").isDirectory)
        assertEquals(pngDraft, model.media.portableAssets(draftAssetDir).getString("assets/plot.png"))

        // Verify workspace.json durable recovery snapshot immediately retains the dirty draft + assets across restart.
        val (crashStore, crashModel) = createViewModel(app, key)
        try {
            val recoveredTab = crashModel.state.value.tabs.first { it.id == smdId }
            assertEquals("# Unsaved critical draft\n\n![plot](assets/plot.png)\n", recoveredTab.content)
            assertEquals(pngDraft, crashModel.media.portableAssets(recoveredTab.assetDirectory).getString("assets/plot.png"))
        } finally {
            crashStore.clear()
        }

        // Restore closed-notes directory, then delete disk file so reload itself fails.
        closedDir.delete()
        model.dismissError()
        assertTrue(smdFile.delete())

        model.reloadFromDisk(smdId)
        waitUntil { model.state.value.error?.contains("Could not reload note") == true || model.documentWriteNeedsAccess(smdId) }
        assertEquals("# Unsaved critical draft\n\n![plot](assets/plot.png)\n", model.state.value.active.content)
        assertEquals(draftAssetDir, model.state.value.active.assetDirectory)
        assertEquals(pngDraft, model.media.portableAssets(draftAssetDir).getString("assets/plot.png"))
        File(app.filesDir, "portable-assets/$draftAssetDir").deleteRecursively()
    }
}
