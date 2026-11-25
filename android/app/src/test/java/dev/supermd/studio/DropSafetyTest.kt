package dev.supermd.studio

import android.app.Application
import android.content.ClipData
import android.content.ClipDescription
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.pm.ProviderInfo
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File
import java.nio.file.Files
import java.util.concurrent.ConcurrentHashMap
import org.json.JSONArray
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class DropSafetyTest {
    private lateinit var app: Application
    private lateinit var tempDir: File
    private lateinit var provider: FakeDropProvider

    class FakeDropProvider : ContentProvider() {
        data class Entry(val name: String, val mime: String?, val bytes: ByteArray)
        val entries = ConcurrentHashMap<String, Entry>()

        override fun onCreate(): Boolean = true

        override fun getType(uri: Uri): String? = entries[uri.lastPathSegment]?.mime

        override fun query(
            uri: Uri,
            projection: Array<out String>?,
            selection: String?,
            selectionArgs: Array<out String>?,
            sortOrder: String?,
        ): Cursor {
            val entry = entries[uri.lastPathSegment]
            val cols = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
            val cursor = MatrixCursor(cols)
            if (entry != null) {
                cursor.addRow(cols.map<String, Any?> { col ->
                    when (col) {
                        OpenableColumns.DISPLAY_NAME -> entry.name
                        OpenableColumns.SIZE -> entry.bytes.size.toLong()
                        else -> null
                    }
                }.toTypedArray())
            }
            return cursor
        }

        override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
            val entry = entries[uri.lastPathSegment] ?: throw java.io.FileNotFoundException(uri.toString())
            val tmp = File.createTempFile("drop-entry-", ".bin")
            tmp.writeBytes(entry.bytes)
            tmp.deleteOnExit()
            return ParcelFileDescriptor.open(tmp, ParcelFileDescriptor.MODE_READ_ONLY)
        }

        override fun insert(uri: Uri, values: ContentValues?): Uri? = null
        override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
        override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
    }

    companion object {
        private const val AUTHORITY = "dev.supermd.studio.test.drops"
        private val VALID_PNG_BYTES = byteArrayOf(
            0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
            0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        )
        private val VALID_SVG_BYTES = """<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="6"/></svg>""".toByteArray(Charsets.UTF_8)
        private val PDF_BYTES = "%PDF-1.7\n1 0 obj\n<<>>\nendobj\n".toByteArray(Charsets.UTF_8)
    }

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication()
        tempDir = Files.createTempDirectory("drop-safety-test").toFile()
        val info = ProviderInfo().apply {
            authority = AUTHORITY
            exported = true
            grantUriPermissions = true
        }
        provider = Robolectric.buildContentProvider(FakeDropProvider::class.java).create(info).get()
        app.getSharedPreferences("studio", Context.MODE_PRIVATE).edit()
            .putBoolean("welcomed", true)
            .putBoolean("autosave", false)
            .commit()
    }

    @After fun tearDown() {
        tempDir.deleteRecursively()
        File(app.filesDir, "attachments").listFiles()?.forEach { it.delete() }
    }

    private fun drainMain(until: (() -> Boolean)? = null) {
        val deadline = System.nanoTime() + 5_000_000_000L
        do {
            Thread.sleep(15)
            shadowOf(Looper.getMainLooper()).idle()
            if (until != null && until()) break
        } while (until != null && System.nanoTime() < deadline)
        for (i in 0 until 4) {
            Thread.sleep(10)
            shadowOf(Looper.getMainLooper()).idle()
        }
    }

    @Test fun dragFilterPreservesInternalAndPlainTextDragsWhileInterceptingExternalFileAndUriDrags() {
        val imageDesc = ClipDescription("photo", arrayOf("image/png"))
        assertFalse(shouldAcceptExternalDrag(localState = Any(), description = imageDesc))

        val plainDesc = ClipDescription("selection", arrayOf("text/plain", "text/html", "chromium/x-webkit-paste"))
        assertFalse(shouldAcceptExternalDrag(localState = null, description = plainDesc))

        assertTrue(shouldAcceptExternalDrag(localState = null, description = imageDesc))
        assertTrue(shouldAcceptExternalDrag(localState = null, description = ClipDescription("pdf", arrayOf("application/pdf"))))
        assertTrue(shouldAcceptExternalDrag(localState = null, description = ClipDescription("zip", arrayOf("application/zip"))))
        assertTrue(shouldAcceptExternalDrag(localState = null, description = ClipDescription("link", arrayOf("text/plain", "text/uri-list"))))

        var externalDrops = 0
        val controller = ExternalDropDragController { externalDrops++ }
        val dropEvent = org.robolectric.shadow.api.Shadow.newInstanceOf(android.view.DragEvent::class.java).also {
            org.robolectric.util.ReflectionHelpers.setField(it, "mAction", android.view.DragEvent.ACTION_DROP)
        }

        // Plain-text / internal WebView drags must return false across the entire lifecycle so View.dispatchDragEvent
        // delegates LOCATION, DROP, and ENDED to WebView.onDragEvent without swallowing drops.
        assertFalse(controller.onDragAction(android.view.DragEvent.ACTION_DRAG_STARTED, null, plainDesc))
        assertFalse(controller.onDragAction(android.view.DragEvent.ACTION_DRAG_ENTERED, null, plainDesc))
        assertFalse(controller.onDragAction(android.view.DragEvent.ACTION_DRAG_LOCATION, null, plainDesc))
        assertFalse(controller.onDrag(null, dropEvent))
        assertFalse(controller.onDragAction(android.view.DragEvent.ACTION_DRAG_ENDED, null, null))
        assertEquals(0, externalDrops)

        // Accepted external file drags own the full session, invoke onExternalDrop on DROP, and reset on ENDED.
        assertTrue(controller.onDragAction(android.view.DragEvent.ACTION_DRAG_STARTED, null, imageDesc))
        assertTrue(controller.onDragAction(android.view.DragEvent.ACTION_DRAG_LOCATION, null, imageDesc))
        assertTrue(controller.onDrag(null, dropEvent))
        assertEquals(1, externalDrops)
        assertTrue(controller.onDragAction(android.view.DragEvent.ACTION_DRAG_ENDED, null, null))

        // Subsequent internal drags after an external session ends still fall through cleanly.
        assertFalse(controller.onDragAction(android.view.DragEvent.ACTION_DRAG_STARTED, Any(), imageDesc))
        assertFalse(controller.onDrag(null, dropEvent))
        assertEquals(1, externalDrops)
    }

    @Test fun nativeDropGuardsOverlaysModalsAndExtractsOnlyContentOrFileUris() {
        val baseState = StudioState(
            tabs = listOf(Note(id = "n1", name = "Note.md", content = "# Note", saved = "# Note")),
            activeId = "n1",
            welcomed = true,
        )
        assertFalse(shouldBlockNativeDrop(baseState))
        assertTrue(shouldBlockNativeDrop(baseState.copy(welcomed = false)))
        assertTrue(shouldBlockNativeDrop(baseState.copy(readerOverlay = true)))
        assertTrue(shouldBlockNativeDrop(baseState.copy(busy = true)))
        assertTrue(shouldBlockNativeDrop(baseState, folderSearchVisible = true))
        assertTrue(shouldBlockNativeDrop(baseState, accessRequestOpen = true))
        assertTrue(shouldBlockNativeDrop(baseState.copy(pendingCloseNoteId = "n1")))
        assertTrue(shouldBlockNativeDrop(baseState.copy(pendingSaveConflictNoteId = "n1")))
        assertTrue(shouldBlockNativeDrop(baseState, settingsOpen = true))
        assertTrue(shouldBlockNativeDrop(baseState, exporting = true))
        assertTrue(shouldBlockNativeDrop(baseState, renaming = true))
        assertTrue(shouldBlockNativeDrop(baseState, contentsShown = true))
        assertTrue(shouldBlockNativeDrop(baseState, drawerOpen = true))

        val contentUri = Uri.parse("content://$AUTHORITY/diagram")
        val fileUri = Uri.fromFile(File(tempDir, "local.png"))
        val webUri = Uri.parse("https://example.com/article")
        val clip = ClipData("drop", arrayOf("text/uri-list"), ClipData.Item(contentUri)).apply {
            addItem(ClipData.Item(webUri))
            addItem(ClipData.Item(fileUri))
            addItem(ClipData.Item("inline text without uri"))
        }
        assertEquals(listOf(contentUri, fileUri), extractDroppedFileUris(clip))
    }

    @Test fun nonImageSpoofedAndPrivateFileDropsAreRejectedWithoutDirtyingAssetsOrMutatingNotes() {
        provider.entries["pdf"] = FakeDropProvider.Entry("lecture.pdf", "application/pdf", PDF_BYTES)
        provider.entries["bmp"] = FakeDropProvider.Entry("legacy.bmp", "image/bmp", "BM123456".toByteArray())
        provider.entries["spoofed"] = FakeDropProvider.Entry("fake.png", "application/octet-stream", PDF_BYTES)

        val secretFile = File(app.filesDir, "secret.png").apply { writeBytes(VALID_PNG_BYTES) }
        val nonImageUris = listOf(
            Uri.parse("content://$AUTHORITY/pdf"),
            Uri.parse("content://$AUTHORITY/bmp"),
            Uri.parse("content://$AUTHORITY/spoofed"),
            Uri.parse("https://example.com/not-a-local-image.png"),
            Uri.parse("content://${app.packageName}.share/secret.png"),
            Uri.fromFile(secretFile),
        )

        val model = StudioViewModel(app)
        drainMain()
        val initialNote = model.state.value.active
        var callbackImages: JSONArray? = JSONArray().put("sentinel")
        var callbackInvoked = false

        model.importDropped(nonImageUris, initialNote.id) { images ->
            callbackImages = images
            callbackInvoked = true
        }
        drainMain { callbackInvoked }

        assertTrue(callbackInvoked)
        assertNull(callbackImages)
        val after = model.state.value.active
        assertEquals(initialNote.content, after.content)
        assertFalse(after.assetsDirty)
        assertEquals(MediaStorage.UNSUPPORTED_DROP_IMAGE_MESSAGE, model.state.value.message)
        secretFile.delete()
    }

    @Test fun mixedDropImportsSupportedImagesWhileSkippingNonImagesCleanly() {
        provider.entries["png"] = FakeDropProvider.Entry("chart.png", "image/png", VALID_PNG_BYTES)
        provider.entries["svg"] = FakeDropProvider.Entry("diagram.svg", "text/xml", VALID_SVG_BYTES)
        provider.entries["pdf"] = FakeDropProvider.Entry("handout.pdf", "application/pdf", PDF_BYTES)

        val model = StudioViewModel(app)
        drainMain()
        val activeId = model.state.value.active.id
        var imported: JSONArray? = null

        model.importDropped(
            listOf(
                Uri.parse("content://$AUTHORITY/png"),
                Uri.parse("content://$AUTHORITY/pdf"),
                Uri.parse("content://$AUTHORITY/svg"),
            ),
            activeId,
        ) { images -> imported = images }
        drainMain { imported != null }

        assertNotNull(imported)
        assertEquals(2, imported!!.length())
        assertEquals("chart", imported!!.getJSONObject(0).getString("alt"))
        assertEquals("diagram", imported!!.getJSONObject(1).getString("alt"))
        assertTrue(model.state.value.active.assetsDirty)
        assertEquals(
            "Skipped 1 unsupported file; only PNG, JPEG, GIF, WebP, AVIF, and SVG images were imported.",
            model.state.value.message,
        )
    }
}
