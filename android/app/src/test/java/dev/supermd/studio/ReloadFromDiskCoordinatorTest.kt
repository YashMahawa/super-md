package dev.supermd.studio

import android.app.Application
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Intent
import android.content.pm.ProviderInfo
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.util.Base64
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.time.Duration
import java.util.UUID
import javax.imageio.ImageIO
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowContentResolver

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ReloadFromDiskCoordinatorTest {
    private fun pngDataUrl(rgb: Int): String {
        val img = BufferedImage(2, 2, BufferedImage.TYPE_INT_ARGB).apply { setRGB(0, 0, rgb); setRGB(1, 1, rgb) }
        val bytes = ByteArrayOutputStream().also { ImageIO.write(img, "png", it) }.toByteArray()
        return "data:image/png;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
    }

    private fun await(condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000
        val looper = shadowOf(Looper.getMainLooper())
        while (System.currentTimeMillis() < deadline && !condition()) {
            looper.idleFor(Duration.ofMillis(40)); Thread.sleep(10)
        }
        looper.idleFor(Duration.ofMillis(40)); assertTrue("Timed out waiting for condition", condition())
    }

    private fun withModel(block: (Application, File, StudioViewModel) -> Unit) {
        val app = RuntimeEnvironment.getApplication()
        val temp = Files.createTempDirectory("reload-coord-test").toFile()
        val key = "reload-coord-${UUID.randomUUID()}"
        val store = ViewModelStore()
        val factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = StudioViewModel(app, workspaceKey = key) as T
        }
        val model = ViewModelProvider(store, factory)[StudioViewModel::class.java].apply { reading(autosave = false) }
        try {
            block(app, temp, model)
        } finally {
            store.clear()
            File(app.filesDir, "workspaces/$key.json").deleteRecursively()
            File(app.filesDir, "workspaces/$key").deleteRecursively()
            temp.deleteRecursively()
        }
    }

    @Test fun cleanAndConflictedReloadUpdatesMarkdownAndPortableNotesAndClearsConflictState() = withModel { app, temp, model ->
        val pngV1 = pngDataUrl(0xFF1565C0.toInt())
        val pngV2 = pngDataUrl(0xFFC62828.toInt())
        val mdFile = File(temp, "Summary.md").apply { writeText("# v1\n", Charsets.UTF_8) }
        model.open(Uri.fromFile(mdFile)); await { model.state.value.active.uri == Uri.fromFile(mdFile).toString() }
        val mdId = model.state.value.active.id
        mdFile.writeText("# v2\n", Charsets.UTF_8)
        val cleanMdJob = model.reloadFromDisk(mdId)
        await { cleanMdJob.isCompleted && model.state.value.active.content == "# v2\n" }
        assertEquals("# v2\n", model.state.value.active.saved)
        assertEquals("Reloaded from disk", model.state.value.message)
        assertTrue(model.state.value.closedTabs.isEmpty())

        val smdFile = File(temp, "Figures.smd")
        smdFile.outputStream().use { model.media.writeFmd(it, "# SMD v1\n![p](assets/p.png)\n", JSONObject().put("assets/p.png", pngV1)) }
        model.open(Uri.fromFile(smdFile)); await { model.state.value.active.uri == Uri.fromFile(smdFile).toString() }
        val smdId = model.state.value.active.id
        smdFile.outputStream().use { model.media.writeFmd(it, "# SMD v2\n![p](assets/p.png)\n", JSONObject().put("assets/p.png", pngV2)) }
        val cleanSmdJob = model.reloadFromDisk(smdId)
        await { cleanSmdJob.isCompleted && model.state.value.active.content.startsWith("# SMD v2") }
        assertEquals(model.state.value.active.content, model.state.value.active.saved)
        assertEquals(pngV2, model.media.portableAssets(model.state.value.active.assetDirectory).getString("assets/p.png"))
        assertEquals("Reloaded from disk", model.state.value.message)

        model.edit(smdId, "# Local conflicted draft\n![p](assets/p.png)\n")
        smdFile.outputStream().use { model.media.writeFmd(it, "# SMD v3\n![p](assets/p.png)\n", JSONObject().put("assets/p.png", pngV1)) }
        model.saveManual()
        await { smdId in model.state.value.conflictedTabIds && model.state.value.pendingSaveConflictNoteId == smdId }
        val conflictReloadJob = model.reloadFromDisk(smdId)
        await { conflictReloadJob.isCompleted && model.state.value.active.content.startsWith("# SMD v3") }
        assertFalse(smdId in model.state.value.conflictedTabIds)
        assertNull(model.state.value.pendingSaveConflictNoteId)
        assertEquals("Reloaded from disk", model.state.value.message)
        assertEquals("Recovered Figures.smd", model.state.value.closedTabs.firstOrNull()?.name)
        model.state.value.tabs.mapNotNull { it.assetDirectory }.forEach { File(app.filesDir, "portable-assets/$it").deleteRecursively() }
        model.state.value.closedTabs.mapNotNull { it.assetDirectory }.forEach { File(app.filesDir, "portable-assets/$it").deleteRecursively() }
    }

    @Test fun dirtyDraftArchivesOnReloadWhileFailedReaderBarrierPreservesDraftUntouched() = withModel { _, temp, model ->
        val file = File(temp, "Draft.md").apply { writeText("# Disk initial\n", Charsets.UTF_8) }
        model.open(Uri.fromFile(file)); await { model.state.value.active.uri == Uri.fromFile(file).toString() }
        val id = model.state.value.active.id
        model.edit(id, "# Local draft keep safe\n")
        file.writeText("# Disk replacement\n", Charsets.UTF_8)

        model.readerFlushRequester = { false }
        val blockedJob = model.reloadFromDisk(id)
        await { blockedJob.isCompleted }
        assertEquals("# Local draft keep safe\n", model.state.value.active.content)
        assertTrue(model.state.value.active.dirty)
        assertTrue(model.state.value.closedTabs.isEmpty())
        assertTrue(model.state.value.message?.contains("reader could not confirm") == true)

        model.readerFlushRequester = { true }
        val reloadJob = model.reloadFromDisk(id)
        await { reloadJob.isCompleted && model.state.value.active.content == "# Disk replacement\n" }
        assertFalse(model.state.value.active.dirty)
        assertEquals("Reloaded from disk", model.state.value.message)
        assertEquals("Recovered Draft.md", model.state.value.closedTabs.single().name)
    }

    @Test fun revokedDocumentPermissionRoutesReloadToDocumentAccessRequests() = withModel { app, temp, model ->
        val backing = File(temp, "Protected.md").apply { writeText("# Accessible\n", Charsets.UTF_8) }
        val authority = "dev.supermd.test.reload.${System.nanoTime()}"
        var readable = true
        val provider = object : ContentProvider() {
            override fun onCreate() = true
            override fun query(u: Uri, p: Array<out String>?, s: String?, a: Array<out String>?, o: String?): Cursor =
                MatrixCursor(arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)).apply { addRow(arrayOf<Any?>("Protected.md", backing.length())) }
            override fun getType(uri: Uri) = "text/markdown"
            override fun insert(uri: Uri, values: ContentValues?): Uri? = null
            override fun delete(uri: Uri, s: String?, a: Array<out String>?) = 0
            override fun update(uri: Uri, v: ContentValues?, s: String?, a: Array<out String>?) = 0
            override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
                if (!readable) throw SecurityException("Permission revoked for $uri")
                return ParcelFileDescriptor.open(backing, ParcelFileDescriptor.parseMode(mode))
            }
        }
        provider.attachInfo(app, ProviderInfo().apply { this.authority = authority; exported = true; grantUriPermissions = true })
        ShadowContentResolver.registerProviderInternal(authority, provider)
        try {
            val docUri = DocumentsContract.buildDocumentUri(authority, "doc/Protected.md")
            app.grantUriPermission(app.packageName, docUri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            model.open(docUri); await { model.state.value.active.uri == docUri.toString() }
            val id = model.state.value.active.id
            model.edit(id, "# Unsaved local edits\n")
            readable = false

            val reloadJob = model.reloadFromDisk(id)
            await { reloadJob.isCompleted && model.documentAccessRequests.value != null }
            val req = model.documentAccessRequests.value
            assertNotNull(req)
            assertEquals(docUri.toString(), req!!.uri)
            assertEquals(id, req.noteId)
            assertFalse(req.writing)
            assertNull(model.state.value.error)
            assertEquals("# Unsaved local edits\n", model.state.value.active.content)
        } finally {
            ShadowContentResolver.reset()
        }
    }
}
